; WinPanel installer
;
; The installer is self-contained for the panel itself: it carries its own
; Node runtime so there are no prerequisites and no network dependency to get
; the panel running. Everything else (web server, mail server, git, extra Node
; versions) is downloaded afterwards from inside the panel, where progress and
; failures can actually be shown.
;
; The heavy lifting - folders, permissions, the restricted build account,
; firewall rules, the service and the setup code - lives in the agent's
; bootstrap command rather than in this script, so it can be tested.

#define AppName "WinPanel"
; Version can be supplied by the build with /DAppVersion=1.2.3. The guard
; matters: without it, this definition would silently win over the one passed
; on the command line and every release would be stamped 0.1.0.
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#define AppPublisher "WinPanel"
#define PanelPort "8443"
#define ServiceId "winpanel-agent"
#define SitesRoot "C:\Sites"

[Setup]
AppId={{8F3C1A94-2E7B-4D5A-9C61-7B2E4F8A1D33}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppVerName={#AppName} {#AppVersion}
VersionInfoDescription=WinPanel - host websites and game servers on Windows
AppCopyright=Copyright 2026 Diminished Studios
; The licence is not permissive, so it is shown and accepted rather than
; buried in the install folder.
LicenseFile=..\..\LICENSE.md
DefaultDirName=C:\WinPanel
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\..\dist
OutputBaseFilename=WinPanel-Setup-x64
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Creating services, firewall rules and local accounts all require elevation.
PrivilegesRequired=admin
WizardStyle=modern
UninstallDisplayName={#AppName}
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; Bundled Node runtime - the reason this installer has no prerequisites.
Source: "staging\bin\node\*"; DestDir: "{app}\bin\node"; Flags: ignoreversion recursesubdirs createallsubdirs
; Service wrapper.
Source: "staging\bin\WinSW.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "staging\bin\WinSW.LICENSE.txt"; DestDir: "{app}\bin"; Flags: ignoreversion
; The agent itself.
Source: "staging\agent\*"; DestDir: "{app}\agent"; Flags: ignoreversion recursesubdirs createallsubdirs
; The built panel interface.
Source: "staging\panel\*"; DestDir: "{app}\panel"; Flags: ignoreversion recursesubdirs createallsubdirs
; The licence travels with every copy, which its Notices clause requires.
Source: "..\..\LICENSE.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\THIRD-PARTY-NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; Permissions are deliberately not set here. Inno Setup's [Dirs] permissions
; can only add access, and the data folder needs the opposite: inheritance
; removed, then access granted to SYSTEM and Administrators alone. The
; bootstrap command does exactly that with icacls, so setting anything here
; would either be ignored or quietly widen access.
Name: "{app}\data"
Name: "{app}\logs"
Name: "{app}\caddy"
Name: "{#SitesRoot}"

[Run]
; Creates folders and permissions, the restricted build account, firewall
; rules, the service, and the one-time setup code.
Filename: "{app}\bin\node\22.21.1\node.exe"; \
  Parameters: """{app}\agent\dist\bootstrap-cli.js"" install"; \
  WorkingDir: "{app}"; \
  StatusMsg: "Setting up WinPanel..."; \
  Flags: runhidden waituntilterminated

Filename: "{code:GetPanelUrl}"; \
  Description: "Open WinPanel now"; \
  Flags: postinstall shellexec nowait

[UninstallRun]
; Sites are kept by default; the wizard asks before removing them.
Filename: "{app}\bin\node\22.21.1\node.exe"; \
  Parameters: """{app}\agent\dist\bootstrap-cli.js"" uninstall{code:GetRemoveSitesFlag}"; \
  WorkingDir: "{app}"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "WinPanelUninstall"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\data\services"
Type: filesandordirs; Name: "{app}\logs"

[Code]
var
  SetupCodePage: TOutputMsgMemoWizardPage;
  RemoveSites: Boolean;

function GetPanelUrl(Param: String): String;
begin
  { The bootstrap command detects the machine's address; this is the local
    fallback used for the "open now" shortcut. }
  Result := 'https://localhost:' + '{#PanelPort}';
end;

{ Upgrading over a running install cannot work while anything is up: the
  panel, the web server, the mail server and a service per website all hold
  files in the program folder open, and Inno Setup would stall on "the file is
  in use" naming a folder rather than a program the user could recognise -
  none of these have a window.

  The previous install's own bootstrap does the enumerating, because only it
  knows what a WinPanel service looks like, and because that logic is testable
  where Pascal here is not. A first install has no such file, so `net stop`
  remains as the fallback that at least frees the panel itself. Result codes
  are ignored throughout: having nothing to stop is the normal case. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Bootstrap: String;
begin
  Result := '';
  Bootstrap := ExpandConstant('{app}\agent\dist\bootstrap-cli.js');

  if FileExists(Bootstrap) and FileExists(ExpandConstant('{app}\bin\node\22.21.1\node.exe')) then
  begin
    Exec(
      ExpandConstant('{app}\bin\node\22.21.1\node.exe'),
      '"' + Bootstrap + '" stop-all',
      ExpandConstant('{app}'),
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode
    );
  end;

  { `net stop` rather than `sc stop` because it waits for the service to
    actually stop instead of merely asking. }
  Exec(
    ExpandConstant('{sys}\net.exe'),
    'stop {#ServiceId} /y',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
end;

function GetRemoveSitesFlag(Param: String): String;
begin
  if RemoveSites then
    Result := ' --remove-sites'
  else
    Result := '';
end;

{ Reads the one-time setup code the bootstrap command wrote, so the final
  page can show it rather than making the user hunt for a file.

  An empty result is how this script knows the difference between a first
  install and an update: the bootstrap writes a code only when the panel has
  no account yet, and the code is destroyed the moment one is created. }
function ReadSetupCode(): String;
var
  Contents: AnsiString;
begin
  Result := '';
  if LoadStringFromFile(ExpandConstant('{app}\data\setup-token.txt'), Contents) then
    Result := Trim(String(Contents));
end;

{ The bootstrap command runs hidden, so anything that went wrong is only
  visible if it is read back and shown here. Silent warnings are how an
  install that never started the service still looks successful. }
function ReadInstallWarnings(): String;
var
  Contents: AnsiString;
begin
  Result := '';
  if LoadStringFromFile(ExpandConstant('{app}\data\install-warnings.txt'), Contents) then
    Result := Trim(String(Contents));
end;

procedure InitializeWizard();
begin
  SetupCodePage := CreateOutputMsgMemoPage(
    wpInfoAfter,
    'WinPanel is ready',
    'Open the address below to finish setting up.',
    'Your setup code is shown here. It is needed once, to create your account.',
    ''
  );
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Message: String;
  Warnings: String;
  SetupCode: String;
begin
  if (SetupCodePage <> nil) and (CurPageID = SetupCodePage.ID) then
  begin
    SetupCode := ReadSetupCode();

    if SetupCode <> '' then
    begin
      SetupCodePage.Caption := 'WinPanel is ready';
      SetupCodePage.Description := 'Open the address below to finish setting up.';

      Message :=
        'Open this address in your browser:' + #13#10 +
        '    https://<this server''s IP address>:' + '{#PanelPort}' + #13#10 + #13#10 +
        'Setup code:' + #13#10 +
        '    ' + SetupCode + #13#10 + #13#10 +
        'The address must start with https, not http. The panel does not answer' + #13#10 +
        'plain http on this port.' + #13#10 + #13#10 +
        'Your browser will warn about the certificate the first time. That is' + #13#10 +
        'expected: the panel is reached by IP address rather than a domain name,' + #13#10 +
        'so its certificate is self-signed. The panel shows you its fingerprint' + #13#10 +
        'so you can confirm you are trusting the right one.';
    end
    else
    begin
      { No setup code means this machine already had a panel with an account
        on it. Showing the first-run instructions here would be nonsense, and
        offering a code nothing can redeem is worse than offering none. }
      SetupCodePage.Caption := 'WinPanel has been updated';
      SetupCodePage.Description := 'Version {#AppVersion} is installed and running.';

      Message :=
        'Everything was put back the way it was:' + #13#10 + #13#10 +
        '    Your websites, mailboxes and settings are untouched.' + #13#10 +
        '    Your sign-in details have not changed.' + #13#10 +
        '    The panel, web server, mail server and websites are running again.' + #13#10 +
        '' + #13#10 +
        'Open this address in your browser and sign in as usual:' + #13#10 +
        '    https://<this server''s IP address>:' + '{#PanelPort}';
    end;

    Warnings := ReadInstallWarnings();
    if Warnings <> '' then
      Message := 'Setup finished, but not everything worked:' + #13#10 + #13#10 +
        Warnings + #13#10 + #13#10 +
        '----------------------------------------' + #13#10 + #13#10 + Message;

    SetupCodePage.RichEditViewer.Text := Message;
  end;
end;

{ The one question the uninstaller has to ask, asked before it starts.

  This used to be a checkbox added to the progress form, which meant the most
  consequential choice the product ever offers - keep or destroy every website
  on the server - appeared next to a progress bar that was already moving. By
  the time it was readable it was arguably already answered.

  Two radio buttons rather than one checkbox: an unticked box is not a decision
  a user has made, and this is not something to be decided by default. Keeping
  is preselected because a wrong "keep" costs disk space and a wrong "delete"
  costs the websites. }
function InitializeUninstall(): Boolean;
var
  Form: TSetupForm;
  Heading: TNewStaticText;
  Body: TNewStaticText;
  KeepChoice: TNewRadioButton;
  KeepHint: TNewStaticText;
  RemoveChoice: TNewRadioButton;
  RemoveHint: TNewStaticText;
  ContinueButton: TNewButton;
  CancelButton: TNewButton;
  ContentWidth: Integer;
  ButtonWidth: Integer;
begin
  RemoveSites := False;

  { Size is fixed at construction from Inno 6.6 onwards, so it cannot be
    trimmed to the content afterwards. Scaling is proportional, so the text
    wraps to the same number of lines at every DPI: this height was measured
    against the laid-out controls rather than guessed. }
  Form := CreateCustomForm(ScaleX(460), ScaleY(252), False, False);
  try
    Form.Caption := 'Remove {#AppName}';

    ContentWidth := Form.ClientWidth - ScaleX(40);

    Heading := TNewStaticText.Create(Form);
    Heading.Parent := Form;
    Heading.Left := ScaleX(20);
    Heading.Top := ScaleY(20);
    Heading.Width := ContentWidth;
    Heading.Font.Style := [fsBold];
    Heading.Caption := 'What should happen to your websites?';

    Body := TNewStaticText.Create(Form);
    Body.Parent := Form;
    Body.Left := ScaleX(20);
    Body.Top := Heading.Top + Heading.Height + ScaleY(10);
    Body.Width := ContentWidth;
    Body.WordWrap := True;
    Body.AutoSize := True;
    Body.Caption :=
      'Removing {#AppName} stops and removes the control panel, the web server, the mail ' +
      'server and every website''s background program. Your website files are separate, ' +
      'and are kept unless you say otherwise.';

    KeepChoice := TNewRadioButton.Create(Form);
    KeepChoice.Parent := Form;
    KeepChoice.Left := ScaleX(20);
    KeepChoice.Top := Body.Top + Body.Height + ScaleY(18);
    KeepChoice.Width := ContentWidth;
    KeepChoice.Caption := 'Keep my website files';
    KeepChoice.Checked := True;

    KeepHint := TNewStaticText.Create(Form);
    KeepHint.Parent := Form;
    KeepHint.Left := ScaleX(38);
    KeepHint.Top := KeepChoice.Top + KeepChoice.Height + ScaleY(2);
    KeepHint.Width := ContentWidth - ScaleX(18);
    KeepHint.WordWrap := True;
    KeepHint.AutoSize := True;
    KeepHint.Caption :=
      '{#SitesRoot} is left exactly as it is, so you can reinstall or move the sites ' +
      'elsewhere later.';

    RemoveChoice := TNewRadioButton.Create(Form);
    RemoveChoice.Parent := Form;
    RemoveChoice.Left := ScaleX(20);
    RemoveChoice.Top := KeepHint.Top + KeepHint.Height + ScaleY(16);
    RemoveChoice.Width := ContentWidth;
    RemoveChoice.Caption := 'Delete my website files as well';

    RemoveHint := TNewStaticText.Create(Form);
    RemoveHint.Parent := Form;
    RemoveHint.Left := ScaleX(38);
    RemoveHint.Top := RemoveChoice.Top + RemoveChoice.Height + ScaleY(2);
    RemoveHint.Width := ContentWidth - ScaleX(18);
    RemoveHint.WordWrap := True;
    RemoveHint.AutoSize := True;
    RemoveHint.Caption :=
      'Everything in {#SitesRoot} is deleted permanently, including uploads and anything ' +
      'not stored elsewhere. This cannot be undone.';

    CancelButton := TNewButton.Create(Form);
    CancelButton.Parent := Form;
    CancelButton.Caption := 'Cancel';
    CancelButton.ModalResult := mrCancel;
    CancelButton.Cancel := True;

    ContinueButton := TNewButton.Create(Form);
    ContinueButton.Parent := Form;
    ContinueButton.Caption := 'Continue';
    ContinueButton.ModalResult := mrOk;
    ContinueButton.Default := True;

    { Left to itself a button sizes to its own caption, which leaves two
      buttons of visibly different widths sitting side by side. }
    ButtonWidth := Form.CalculateButtonWidth([ContinueButton.Caption, CancelButton.Caption]);

    CancelButton.Width := ButtonWidth;
    CancelButton.Height := ScaleY(26);
    CancelButton.Left := Form.ClientWidth - ScaleX(20) - ButtonWidth;
    CancelButton.Top := Form.ClientHeight - ScaleY(20) - CancelButton.Height;

    ContinueButton.Width := ButtonWidth;
    ContinueButton.Height := ScaleY(26);
    ContinueButton.Left := CancelButton.Left - ScaleX(8) - ButtonWidth;
    ContinueButton.Top := CancelButton.Top;

    Form.ActiveControl := KeepChoice;

    Result := Form.ShowModal() = mrOk;
    if Result then
      RemoveSites := RemoveChoice.Checked;
  finally
    Form.Free();
  end;
end;
