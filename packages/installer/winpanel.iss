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

[Setup]
AppId={{8F3C1A94-2E7B-4D5A-9C61-7B2E4F8A1D33}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
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
; The agent itself.
Source: "staging\agent\*"; DestDir: "{app}\agent"; Flags: ignoreversion recursesubdirs createallsubdirs
; The built panel interface.
Source: "staging\panel\*"; DestDir: "{app}\panel"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
; Permissions are deliberately not set here. Inno Setup's [Dirs] permissions
; can only add access, and the data folder needs the opposite: inheritance
; removed, then access granted to SYSTEM and Administrators alone. The
; bootstrap command does exactly that with icacls, so setting anything here
; would either be ignored or quietly widen access.
Name: "{app}\data"
Name: "{app}\logs"
Name: "{app}\caddy"
Name: "C:\Sites"

[Run]
; Creates folders and permissions, the restricted build account, firewall
; rules, the service, and the one-time setup code.
Filename: "{app}\bin\node\node.exe"; \
  Parameters: """{app}\agent\dist\bootstrap-cli.js"" install"; \
  WorkingDir: "{app}"; \
  StatusMsg: "Setting up WinPanel..."; \
  Flags: runhidden waituntilterminated

Filename: "{code:GetPanelUrl}"; \
  Description: "Open WinPanel now"; \
  Flags: postinstall shellexec nowait

[UninstallRun]
; Sites are kept by default; the wizard asks before removing them.
Filename: "{app}\bin\node\node.exe"; \
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
  RemoveSitesCheckbox: TNewCheckBox;

function GetPanelUrl(Param: String): String;
begin
  { The bootstrap command detects the machine's address; this is the local
    fallback used for the "open now" shortcut. }
  Result := 'https://localhost:' + '{#PanelPort}';
end;

{ Upgrading over a running install cannot work while the service is up: it
  holds node.exe and the agent's native modules open, and Inno Setup would
  stall on "the file is in use" for files the user has no idea about. `net
  stop` is used rather than `sc stop` because it waits for the service to
  actually stop instead of merely asking. A first install has nothing to stop,
  so the result code is deliberately ignored. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
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
  if (RemoveSitesCheckbox <> nil) and RemoveSitesCheckbox.Checked then
    Result := ' --remove-sites'
  else
    Result := '';
end;

{ Reads the one-time setup code the bootstrap command wrote, so the final
  page can show it rather than making the user hunt for a file. }
function ReadSetupCode(): String;
var
  Contents: AnsiString;
begin
  if LoadStringFromFile(ExpandConstant('{app}\data\setup-token.txt'), Contents) then
    Result := Trim(String(Contents))
  else
    Result := '(check {app}\data\setup-token.txt)';
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
begin
  if (SetupCodePage <> nil) and (CurPageID = SetupCodePage.ID) then
  begin
    Message :=
      'Open this address in your browser:' + #13#10 +
      '    https://<this server''s IP address>:' + '{#PanelPort}' + #13#10 + #13#10 +
      'Setup code:' + #13#10 +
      '    ' + ReadSetupCode() + #13#10 + #13#10 +
      'The address must start with https, not http. The panel does not answer' + #13#10 +
      'plain http on this port.' + #13#10 + #13#10 +
      'Your browser will warn about the certificate the first time. That is' + #13#10 +
      'expected: the panel is reached by IP address rather than a domain name,' + #13#10 +
      'so its certificate is self-signed. The panel shows you its fingerprint' + #13#10 +
      'so you can confirm you are trusting the right one.';

    Warnings := ReadInstallWarnings();
    if Warnings <> '' then
      Message := 'Setup finished, but not everything worked:' + #13#10 + #13#10 +
        Warnings + #13#10 + #13#10 +
        '----------------------------------------' + #13#10 + #13#10 + Message;

    SetupCodePage.RichEditViewer.Text := Message;
  end;
end;

procedure InitializeUninstallProgressForm();
begin
  RemoveSitesCheckbox := TNewCheckBox.Create(UninstallProgressForm);
  RemoveSitesCheckbox.Parent := UninstallProgressForm.InnerPage;
  RemoveSitesCheckbox.Left := ScaleX(16);
  RemoveSitesCheckbox.Top := UninstallProgressForm.StatusLabel.Top + ScaleY(48);
  RemoveSitesCheckbox.Width := UninstallProgressForm.InnerPage.ClientWidth - ScaleX(32);
  RemoveSitesCheckbox.Caption := 'Also delete all website files in C:\Sites';
  { Unchecked by default: removing the panel should not destroy the websites. }
  RemoveSitesCheckbox.Checked := False;
end;
