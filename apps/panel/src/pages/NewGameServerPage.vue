<script setup lang="ts">
import { computed, ref } from 'vue';
import { ArrowLeft, ArrowRight, Check, LockKeyhole, RefreshCw, Server, Sparkles } from 'lucide-vue-next';
import { RouterLink, useRouter } from 'vue-router';
import { api, describeError } from '../lib/api';
import AlertMessage from '../components/AlertMessage.vue';
import LoadingBlock from '../components/LoadingBlock.vue';
import PageHeader from '../components/PageHeader.vue';

const router = useRouter();
type CatalogEntry = Awaited<ReturnType<typeof api.gameServers.catalogue.query>>[number];

const catalogue = ref<ReadonlyArray<CatalogEntry>>([]);
const selectedId = ref<string | null>(null);
const name = ref('');
const version = ref('');
const eulaAccepted = ref(false);
const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);
const catalogueCount = ref<number | null>(null);
type CatalogueStatus = Awaited<ReturnType<typeof api.gameServers.catalogueStatus.query>>;
const catalogueStatus = ref<CatalogueStatus | null>(null);
const reloading = ref(false);
const notice = ref<string | null>(null);

const selected = computed(() => catalogue.value.find((entry) => entry.id === selectedId.value) ?? null);
const readyGames = computed(() => catalogue.value.filter((entry) => entry.status === 'ready'));
const plannedGames = computed(() => catalogue.value.filter((entry) => entry.status === 'planned'));
const canCreate = computed(() => Boolean(selected.value && name.value.trim() && eulaAccepted.value));

async function load(): Promise<void> {
  loading.value = true;
  try {
    catalogue.value = await api.gameServers.catalogue.query();
    catalogueCount.value = (await api.gameServers.catalogueCount.query()).count;
    // Admin-only, and a customer seeing the picker should not be an error.
    catalogueStatus.value = await api.gameServers.catalogueStatus.query().catch(() => null);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

/*
 * The catalog folder is meant to be edited on the machine, so the panel offers
 * a reload rather than making "I added a game" mean "restart the agent".
 */
async function reloadCatalogue(): Promise<void> {
  reloading.value = true;
  error.value = null;
  notice.value = null;
  try {
    const result = await api.gameServers.reloadCatalogue.mutate();
    await load();
    notice.value = `${result.loaded} config${result.loaded === 1 ? '' : 's'} loaded.`;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    reloading.value = false;
  }
}

function choose(entry: CatalogEntry): void {
  if (entry.status !== 'ready') return;
  selectedId.value = entry.id;
  if (!name.value) name.value = entry.name;
}

async function create(): Promise<void> {
  if (!selected.value || !canCreate.value) return;
  busy.value = true;
  error.value = null;
  try {
    const server = await api.gameServers.create.mutate({
      displayName: name.value.trim(),
      catalogId: selected.value.id,
      version: version.value.trim() || undefined,
      eulaAccepted: eulaAccepted.value,
    });
    await router.push(`/game-servers/${server.slug}`);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

function artClass(entry: CatalogEntry): string {
  return `game-art-${entry.art}`;
}

function artUrl(entry: CatalogEntry): string | null {
  return (entry.artUrl ?? entry.steamArtAppId ?? entry.steamAppId)
    ? `/api/game-servers/catalogue/${encodeURIComponent(entry.id)}/art`
    : null;
}

function hideArtwork(event: Event): void {
  (event.currentTarget as HTMLImageElement).style.display = 'none';
}

void load();
</script>

<template>
  <div class="mx-auto w-full max-w-7xl">
    <RouterLink to="/game-servers" class="mb-5 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
      <ArrowLeft :size="15" aria-hidden="true" /> Game Servers
    </RouterLink>

    <PageHeader
      title="Choose a game"
      description="Pick a supported Windows server from the library. Ready titles can be installed now; the rest are being tested provider by provider."
    />

    <AlertMessage v-if="error" class="mb-5">{{ error }}</AlertMessage>
    <AlertMessage v-if="notice" tone="success" class="mb-5">{{ notice }}</AlertMessage>
    <AlertMessage v-if="catalogueStatus && catalogueStatus.rejected.length > 0" tone="warning" class="mb-5">
      <p class="font-medium">
        {{ catalogueStatus.rejected.length }} game config{{ catalogueStatus.rejected.length === 1 ? ' was' : 's were' }}
        skipped because {{ catalogueStatus.rejected.length === 1 ? 'it does' : 'they do' }} not match the schema.
      </p>
      <ul class="mt-2 space-y-1 text-xs">
        <li v-for="problem in catalogueStatus.rejected" :key="problem.file">
          <span class="font-mono">{{ problem.file }}</span> — {{ problem.error }}
        </li>
      </ul>
    </AlertMessage>
    <LoadingBlock v-if="loading" class="h-96 rounded-card bg-surface" />

    <template v-else>
      <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <main>
          <div class="mb-3 flex items-center justify-between">
            <div>
              <p class="text-xs font-semibold uppercase tracking-[0.18em] text-brand-bright">Your library</p>
              <h2 class="mt-1 text-xl font-semibold tracking-tight text-ink">Server-ready games</h2>
              <p v-if="catalogueCount !== null" class="mt-1 text-xs text-ink-faint">
                {{ catalogueCount }} config{{ catalogueCount === 1 ? '' : 's' }} loaded
                <template v-if="catalogueStatus">
                  from <span class="font-mono">{{ catalogueStatus.directory }}</span>
                </template>
              </p>
            </div>
            <div class="flex items-center gap-3">
              <button
                v-if="catalogueStatus"
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="reloading"
                title="Re-read the catalogue folder after adding or editing a game config"
                @click="reloadCatalogue"
              >
                <RefreshCw :size="14" aria-hidden="true" /> Reload configs
              </button>
              <span class="text-sm text-ink-faint">{{ readyGames.length }} available</span>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <button
              v-for="entry in readyGames"
              :key="entry.id"
              type="button"
              class="game-card group text-left"
              :class="selectedId === entry.id ? 'game-card-selected' : ''"
              @click="choose(entry)"
            >
              <div class="game-art" :class="artClass(entry)">
                <span class="game-art-grid" aria-hidden="true" />
                <span class="game-art-mark">{{ entry.name.slice(0, 1) }}</span>
                <img
                  v-if="artUrl(entry)"
                  :src="artUrl(entry)!"
                  :alt="`${entry.name} cover art`"
                  class="game-art-image"
                  loading="lazy"
                  @error="hideArtwork"
                />
                <span class="game-art-chip">READY</span>
              </div>
              <div class="p-3">
                <p class="truncate text-sm font-semibold text-ink">{{ entry.name }}</p>
                <p class="mt-1 text-xs text-ink-faint">{{ entry.genre }} · {{ entry.provider === 'steam' ? 'Steam' : 'Official' }}</p>
              </div>
            </button>
          </div>

          <div class="mt-10 mb-3 flex items-center justify-between">
            <div>
              <p class="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">On the horizon</p>
              <h2 class="mt-1 text-xl font-semibold tracking-tight text-ink">More of your library</h2>
            </div>
            <span class="text-sm text-ink-faint">{{ plannedGames.length }} in testing</span>
          </div>

          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <div v-for="entry in plannedGames" :key="entry.id" class="game-card game-card-planned">
              <div class="game-art" :class="artClass(entry)">
                <span class="game-art-grid" aria-hidden="true" />
                <span class="game-art-mark">{{ entry.name.slice(0, 1) }}</span>
                <img
                  v-if="artUrl(entry)"
                  :src="artUrl(entry)!"
                  :alt="`${entry.name} cover art`"
                  class="game-art-image"
                  loading="lazy"
                  @error="hideArtwork"
                />
                <span class="game-art-chip game-art-chip-planned">SOON</span>
              </div>
              <div class="p-3">
                <p class="truncate text-sm font-semibold text-ink-muted">{{ entry.name }}</p>
                <p class="mt-1 text-xs text-ink-faint">{{ entry.genre }} · Adapter testing</p>
              </div>
            </div>
          </div>
        </main>

        <aside class="xl:sticky xl:top-6 xl:self-start">
          <section class="card overflow-hidden">
            <div v-if="selected" class="selected-hero" :class="artClass(selected)">
              <span class="game-art-grid" aria-hidden="true" />
              <span class="selected-hero-mark">{{ selected.name.slice(0, 1) }}</span>
              <img
                v-if="artUrl(selected)"
                :src="artUrl(selected)!"
                :alt="`${selected.name} cover art`"
                class="game-art-image"
                @error="hideArtwork"
              />
              <span class="selected-hero-kicker">SELECTED SERVER</span>
            </div>
            <div v-else class="flex min-h-44 flex-col items-center justify-center bg-black/20 p-6 text-center">
              <Sparkles :size="23" class="text-brand-bright" aria-hidden="true" />
              <p class="mt-3 text-sm font-medium text-ink">Pick a title to begin</p>
              <p class="mt-1 text-xs text-ink-faint">Your server setup will appear here.</p>
            </div>

            <form class="space-y-4 p-5" @submit.prevent="create">
              <div v-if="selected">
                <h2 class="text-lg font-semibold text-ink">{{ selected.name }}</h2>
                <p class="mt-1 text-sm leading-relaxed text-ink-muted">{{ selected.description }}</p>
              </div>

              <div class="space-y-1">
                <label class="label" for="new-game-server-name">Server name</label>
                <input id="new-game-server-name" v-model="name" class="field" :disabled="!selected" placeholder="Choose a title first" />
              </div>

              <div class="space-y-1">
                <label class="label" for="new-game-server-version">Version</label>
                <input id="new-game-server-version" v-model="version" class="field" :disabled="!selected" placeholder="Provider default" />
              </div>

              <div v-if="selected" class="rounded-lg border border-line bg-black/20 p-3 text-xs text-ink-muted">
                <div class="flex items-center gap-2 text-ink">
                  <Server :size="14" class="text-brand-bright" aria-hidden="true" />
                  <span>{{ selected.ports.length }} network binding{{ selected.ports.length === 1 ? '' : 's' }}</span>
                </div>
                <p class="mt-2">WinPanel allocates safe ports, registers the Windows service, and keeps editable data separate from provider files.</p>
              </div>

              <label v-if="selected" class="flex items-start gap-2 text-sm text-ink-muted">
                <input v-model="eulaAccepted" type="checkbox" class="mt-0.5" />
                <span>I accept the applicable game EULA and distribution terms.</span>
              </label>

              <button type="submit" class="btn btn-primary w-full justify-center" :disabled="busy || !canCreate">
                <Check v-if="!busy" :size="15" aria-hidden="true" />
                {{ busy ? 'Creating...' : 'Create server' }}
                <ArrowRight v-if="!busy" :size="15" aria-hidden="true" />
              </button>
              <p class="flex items-center gap-1.5 text-xs text-ink-faint">
                <LockKeyhole :size="12" aria-hidden="true" /> Provider commands are allowlisted by WinPanel.
              </p>
            </form>
          </section>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.game-card {
  overflow: hidden;
  border: 1px solid rgb(255 255 255 / 0.08);
  border-radius: 10px;
  background: rgb(255 255 255 / 0.035);
  box-shadow: 0 12px 30px rgb(0 0 0 / 0.14);
  transition: border-color 180ms ease, transform 180ms ease, box-shadow 180ms ease;
}

.game-card:hover {
  transform: translateY(-3px);
  border-color: rgb(255 255 255 / 0.22);
  box-shadow: 0 18px 40px rgb(0 0 0 / 0.24);
}

.game-card-selected {
  border-color: rgb(91 214 153 / 0.8);
  box-shadow: 0 0 0 2px rgb(91 214 153 / 0.16), 0 20px 44px rgb(0 0 0 / 0.26);
}

.game-card-planned {
  opacity: 0.68;
}

.game-art,
.selected-hero {
  position: relative;
  overflow: hidden;
  background: #263b44;
}

.game-art {
  aspect-ratio: 0.82;
}

.selected-hero {
  min-height: 190px;
}

.game-art-grid {
  position: absolute;
  inset: 0;
  opacity: 0.3;
  background-image: linear-gradient(135deg, rgb(255 255 255 / 0.12) 1px, transparent 1px), linear-gradient(45deg, rgb(0 0 0 / 0.15) 1px, transparent 1px);
  background-size: 22px 22px, 28px 28px;
  transform: scale(1.2) rotate(-8deg);
}

.game-art-image {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  transition: transform 220ms ease, filter 220ms ease;
}

.game-card:hover .game-art-image {
  transform: scale(1.04);
  filter: saturate(1.08);
}

.game-art-mark,
.selected-hero-mark {
  position: absolute;
  color: rgb(255 255 255 / 0.88);
  font-family: Georgia, serif;
  font-weight: 700;
  line-height: 0.8;
  text-shadow: 4px 5px 0 rgb(0 0 0 / 0.2);
  /* Below the capsule image: the mark is the fallback, not an overlay. */
  z-index: 1;
}

.game-art-mark {
  right: 13%;
  bottom: 12%;
  font-size: clamp(4rem, 8vw, 7rem);
}

.selected-hero-mark {
  right: 11%;
  bottom: 8%;
  font-size: 8rem;
}

.game-art-chip,
.selected-hero-kicker {
  position: absolute;
  top: 12px;
  left: 12px;
  border: 1px solid rgb(255 255 255 / 0.26);
  border-radius: 999px;
  background: rgb(0 0 0 / 0.2);
  color: rgb(255 255 255 / 0.86);
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  padding: 4px 7px;
  z-index: 3;
}

.game-art-chip-planned {
  color: rgb(255 255 255 / 0.62);
}

.selected-hero-kicker {
  top: auto;
  bottom: 14px;
}

.game-art-forest { background: linear-gradient(145deg, #173c38, #70a45d 52%, #d3b46d); }
.game-art-neon { background: linear-gradient(145deg, #191d4d, #cd3e8c 54%, #f5cf5c); }
.game-art-ember { background: linear-gradient(145deg, #5b1e23, #d76838 55%, #efc36a); }
.game-art-ocean { background: linear-gradient(145deg, #123b55, #21899a 55%, #a4d6c5); }
.game-art-desert { background: linear-gradient(145deg, #72502c, #c9854a 56%, #e4d08e); }
.game-art-violet { background: linear-gradient(145deg, #2c204e, #7b56a4 55%, #dd91b4); }
.game-art-steel { background: linear-gradient(145deg, #26343e, #5f7881 55%, #c5b897); }
</style>
