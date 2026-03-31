export interface RepoGroup<T> {
  repoFullName: string;
  items: T[];
}

export function groupByRepo<T extends { repoFullName: string }>(items: T[]): RepoGroup<T>[] {
  const groups: RepoGroup<T>[] = [];
  const map = new Map<string, RepoGroup<T>>();
  for (const item of items) {
    let group = map.get(item.repoFullName);
    if (!group) {
      group = { repoFullName: item.repoFullName, items: [] };
      map.set(item.repoFullName, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

export function computePageLayout<T>(
  groups: RepoGroup<T>[],
  approxPageSize: number,
): { boundaries: number[]; pageCount: number } {
  if (groups.length === 0) return { boundaries: [0], pageCount: 1 };

  const boundaries: number[] = [0];
  let currentPageItems = 0;
  for (let i = 0; i < groups.length; i++) {
    if (currentPageItems > 0 && currentPageItems + groups[i].items.length > approxPageSize) {
      boundaries.push(i);
      currentPageItems = 0;
    }
    currentPageItems += groups[i].items.length;
  }

  return { boundaries, pageCount: Math.max(1, boundaries.length) };
}

export function slicePageGroups<T>(
  groups: RepoGroup<T>[],
  boundaries: number[],
  pageCount: number,
  page: number,
): RepoGroup<T>[] {
  const clampedPage = Math.max(0, Math.min(page, pageCount - 1));
  const start = boundaries[clampedPage];
  const end = clampedPage + 1 < boundaries.length ? boundaries[clampedPage + 1] : groups.length;
  return groups.slice(start, end);
}

export function orderRepoGroups<G extends { repoFullName: string }>(
  groups: G[],
  lockedOrder: string[]
): G[] {
  const lockedIndex = new Map(lockedOrder.map((name, i) => [name, i]));
  const locked: G[] = [];
  const unlocked: G[] = [];

  for (const group of groups) {
    if (lockedIndex.has(group.repoFullName)) {
      locked.push(group);
    } else {
      unlocked.push(group);
    }
  }

  locked.sort((a, b) =>
    (lockedIndex.get(a.repoFullName) ?? 0) - (lockedIndex.get(b.repoFullName) ?? 0)
  );

  return [...locked, ...unlocked];
}

export function detectReorderedRepos(
  previousOrder: string[],
  currentOrder: string[]
): Set<string> {
  // Filter both lists to only repos present in both — ignoring additions/removals
  // so that inserting or removing a repo doesn't flag everything below it as "moved".
  const currentSet = new Set(currentOrder);
  const prevCommon = previousOrder.filter((r) => currentSet.has(r));
  const prevSet = new Set(previousOrder);
  const curCommon = currentOrder.filter((r) => prevSet.has(r));

  const moved = new Set<string>();
  const prevIndex = new Map(prevCommon.map((name, i) => [name, i]));
  for (let i = 0; i < curCommon.length; i++) {
    const prev = prevIndex.get(curCommon[i]);
    if (prev !== undefined && prev !== i) {
      moved.add(curCommon[i]);
    }
  }
  return moved;
}
