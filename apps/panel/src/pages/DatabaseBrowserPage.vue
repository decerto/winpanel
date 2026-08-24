<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { ArrowLeft, Search, Table2, Trash2 } from 'lucide-vue-next';
import { api, describeError } from '../lib/api';
import AlertMessage from '../components/AlertMessage.vue';
import EmptyState from '../components/EmptyState.vue';
import LoadingBlock from '../components/LoadingBlock.vue';
import PageHeader from '../components/PageHeader.vue';
import PaginationBar from '../components/PaginationBar.vue';

/**
 * Looking inside a MongoDB database.
 *
 * The two SQL engines are browsed with Adminer, which the panel proxies. There
 * is no equivalent for MongoDB on Windows — Adminer's driver for it needs a
 * PECL extension PHP does not ship — so rather than leave MongoDB as the one
 * engine you cannot see into, the panel reads it directly.
 *
 * Writes use the database's own login through the agent, so this page cannot
 * reach data outside the database the signed-in person owns.
 */

const route = useRoute();
const id = computed(() => route.params['id'] as string);

type Collections = Awaited<ReturnType<typeof api.databases.mongoCollections.query>>;
type Documents = Awaited<ReturnType<typeof api.databases.mongoDocuments.query>>;

const PAGE_SIZE = 20;

const collections = ref<Collections | null>(null);
const documents = ref<Documents | null>(null);
const selected = ref<string | null>(null);
const page = ref(1);
const filter = ref('');
/** The filter that was actually sent, so editing the box does not re-query. */
const appliedFilter = ref('');
const insertJson = ref('{\n  \n}');
const updateFilter = ref('');
const updateJson = ref('{\n  \n}');
const deleteFilter = ref('');
const updateMany = ref(false);
const deleteMany = ref(false);
const writing = ref(false);

const loading = ref(true);
const loadingDocuments = ref(false);
const error = ref<string | null>(null);

async function loadCollections(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    collections.value = await api.databases.mongoCollections.query({ id: id.value });
    selected.value = collections.value.collections[0]?.name ?? null;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function loadDocuments(): Promise<void> {
  if (!selected.value) {
    documents.value = null;
    return;
  }

  loadingDocuments.value = true;
  error.value = null;

  try {
    documents.value = await api.databases.mongoDocuments.query({
      id: id.value,
      collection: selected.value,
      page: page.value,
      pageSize: PAGE_SIZE,
      ...(appliedFilter.value ? { filter: appliedFilter.value } : {}),
    });
  } catch (err) {
    error.value = describeError(err);
    documents.value = null;
  } finally {
    loadingDocuments.value = false;
  }
}

function choose(name: string): void {
  selected.value = name;
  page.value = 1;
  appliedFilter.value = '';
  filter.value = '';
}

function applyFilter(): void {
  appliedFilter.value = filter.value.trim();
  page.value = 1;
  void loadDocuments();
}

async function insert(): Promise<void> {
  if (!selected.value) return;
  writing.value = true;
  error.value = null;
  try {
    await api.databases.mongoInsert.mutate({
      id: id.value,
      collection: selected.value,
      document: insertJson.value,
    });
    await loadCollections();
    await loadDocuments();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    writing.value = false;
  }
}

async function update(): Promise<void> {
  if (!selected.value) return;
  writing.value = true;
  error.value = null;
  try {
    await api.databases.mongoUpdate.mutate({
      id: id.value,
      collection: selected.value,
      filter: updateFilter.value,
      update: updateJson.value,
      many: updateMany.value,
    });
    await loadCollections();
    await loadDocuments();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    writing.value = false;
  }
}

async function remove(): Promise<void> {
  if (!selected.value || !window.confirm('Delete the matching MongoDB documents?')) return;
  writing.value = true;
  error.value = null;
  try {
    await api.databases.mongoDelete.mutate({
      id: id.value,
      collection: selected.value,
      filter: deleteFilter.value,
      many: deleteMany.value,
    });
    await loadCollections();
    await loadDocuments();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    writing.value = false;
  }
}

watch([selected, page], loadDocuments);

onMounted(async () => {
  await loadCollections();
  await loadDocuments();
});
</script>

<template>
  <div class="max-w-6xl">
    <RouterLink
      to="/databases"
      class="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
    >
      <ArrowLeft :size="15" aria-hidden="true" /> All databases
    </RouterLink>

    <PageHeader
      title="Browse database"
      description="Browse and change documents in this MongoDB database. All operations use the
                   database account's own permissions."
    />

    <AlertMessage v-if="error" tone="danger" class="mb-4">{{ error }}</AlertMessage>

    <LoadingBlock v-if="loading" class="h-64 rounded-card bg-surface" />

    <EmptyState
      v-else-if="collections && collections.collections.length === 0"
      :icon="Table2"
      title="Nothing in here yet"
      description="This database has no collections. One appears as soon as your application
                   writes its first document."
    />

    <div v-else-if="collections" class="grid gap-5 lg:grid-cols-[16rem_1fr]">
      <!-- The collections, as a list rather than a dropdown: on a database
           with a handful of them, seeing the document counts side by side is
           most of what somebody came here to find out. -->
      <aside class="card h-max overflow-hidden">
        <h3 class="border-b border-line px-4 py-3 text-xs uppercase tracking-wide text-ink-faint">
          Collections
        </h3>
        <ul class="divide-y divide-line">
          <li v-for="collection in collections.collections" :key="collection.name">
            <button
              type="button"
              class="flex w-full items-baseline justify-between gap-2 px-4 py-2.5 text-left text-sm
                     hover:bg-elevated"
              :class="selected === collection.name ? 'bg-elevated text-ink' : 'text-ink-muted'"
              @click="choose(collection.name)"
            >
              <span class="min-w-0 truncate font-mono">{{ collection.name }}</span>
              <span class="shrink-0 text-xs text-ink-faint">{{ collection.documents }}</span>
            </button>
          </li>
        </ul>
      </aside>

      <section class="min-w-0 space-y-4">
        <form class="flex gap-2" @submit.prevent="applyFilter">
          <input
            v-model="filter"
            class="field flex-1 font-mono text-xs"
            placeholder='Filter, as JSON — for example {"name": "Ada"}'
            aria-label="Filter documents"
          />
          <button type="submit" class="btn btn-ghost btn-sm shrink-0">
            <Search :size="13" aria-hidden="true" /> Filter
          </button>
        </form>

        <div class="grid gap-4 xl:grid-cols-3">
          <form class="card space-y-3 p-4" @submit.prevent="insert">
            <h3 class="text-sm font-semibold text-ink">Insert document</h3>
            <textarea
              v-model="insertJson"
              class="field min-h-32 w-full font-mono text-xs"
              aria-label="Document to insert"
              spellcheck="false"
            />
            <button type="submit" class="btn btn-primary btn-sm" :disabled="writing">
              Insert
            </button>
          </form>

          <form class="card space-y-3 p-4" @submit.prevent="update">
            <h3 class="text-sm font-semibold text-ink">Update documents</h3>
            <input
              v-model="updateFilter"
              class="field w-full font-mono text-xs"
              placeholder='Filter, for example {"status": "draft"}'
              aria-label="Update filter"
            />
            <textarea
              v-model="updateJson"
              class="field min-h-24 w-full font-mono text-xs"
              aria-label="Update document"
              spellcheck="false"
            />
            <label class="flex items-center gap-2 text-xs text-ink-muted">
              <input v-model="updateMany" type="checkbox" /> Update every match
            </label>
            <button type="submit" class="btn btn-ghost btn-sm" :disabled="writing">
              Update
            </button>
          </form>

          <form class="card space-y-3 p-4" @submit.prevent="remove">
            <h3 class="text-sm font-semibold text-ink">Delete documents</h3>
            <input
              v-model="deleteFilter"
              class="field w-full font-mono text-xs"
              placeholder='Filter, for example {"status": "draft"}'
              aria-label="Delete filter"
            />
            <label class="flex items-center gap-2 text-xs text-ink-muted">
              <input v-model="deleteMany" type="checkbox" /> Delete every match
            </label>
            <button type="submit" class="btn btn-danger btn-sm" :disabled="writing">
              <Trash2 :size="13" aria-hidden="true" /> Delete
            </button>
          </form>
        </div>

        <LoadingBlock v-if="loadingDocuments" class="h-64 rounded-card bg-surface" />

        <EmptyState
          v-else-if="documents && documents.documents.length === 0"
          :icon="Table2"
          title="No matching documents"
          :description="
            appliedFilter
              ? 'Nothing in this collection matches that filter.'
              : 'This collection is empty.'
          "
        />

        <template v-else-if="documents">
          <p class="text-xs text-ink-faint">
            {{ documents.total }}
            {{ documents.total === 1 ? 'document' : 'documents' }} in
            <span class="font-mono">{{ documents.collection }}</span>
          </p>

          <ul class="space-y-3">
            <li
              v-for="(document, index) in documents.documents"
              :key="`${documents.page}-${index}`"
              class="card overflow-hidden"
            >
              <pre
                class="max-h-96 overflow-auto whitespace-pre-wrap break-words bg-black/25 p-4
                       font-mono text-xs leading-relaxed text-ink"
              >{{ document }}</pre>
            </li>
          </ul>

          <PaginationBar
            v-model:page="page"
            :total="documents.total"
            :page-size="documents.pageSize"
            noun="documents"
          />
        </template>
      </section>
    </div>
  </div>
</template>
