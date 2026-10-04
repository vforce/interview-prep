# Interview Recovery System

You forgot everything. That's fine — relearning is ~5x faster than first learning.
You don't re-do 200 problems. You reload **~25 patterns** and re-solve **one canonical
problem each** to confirm the muscle memory is back.

---

## How to use it (the protocol)

**Tier 0 — Reload the map (20 min, no coding).**
Read the [Trigger index](#trigger-index) top to bottom. Don't solve anything. You're just
re-indexing your brain: "when I see X, I reach for Y." This alone recovers most of it.

**Tier 1 — Core 14 (half a day).**
Solve the [Core 14](#core-14-smoke-test), one sitting or two. Time-box each (20 min easy/med,
30 min hard). After each, grade yourself:
- 🟢 solved clean, no peeking, in time → pattern is back, move on
- 🟡 solved but slow, or peeked once → re-read its insight, move on
- 🔴 stuck or wrong → that pattern is a gap. Add it to [Weak set](#weak-set).

**Tier 2 — Full sweep (before a real interview loop).**
Walk every pattern in [Patterns](#patterns). Same traffic-light grading. 🟢 patterns you
skip in seconds; only 🔴/🟡 cost time. That's the whole trick — the system spends your
time only where you're actually weak.

**Cadence.**
- Staying warm: run the **Core 14** monthly (~half a day).
- Interview incoming: **Full sweep**, then drill your **Weak set** daily.
- Keep failing the same pattern? It lives in Weak set permanently — do it first, every time.

> Checkboxes below are your *current* state. To keep history, `cp RECOVERY.md cycles/2026-06.md` before a cycle.

---

## Core 14 smoke test

One canonical per major family. If all 14 are 🟢 you're broadly back.

- [ ] 1. [3Sum](https://leetcode.com/problems/3sum/) — two pointers
- [ ] 2. [209 Min Size Subarray Sum](https://leetcode.com/problems/minimum-size-subarray-sum/) — sliding window
- [ ] 3. [560 Subarray Sum Equals K](https://leetcode.com/problems/subarray-sum-equals-k/) — prefix sum + hashmap
- [ ] 4. [215 Kth Largest Element](https://leetcode.com/problems/kth-largest-element-in-an-array/) — heap / top-K
- [ ] 5. [56 Merge Intervals](https://leetcode.com/problems/merge-intervals/) — intervals
- [ ] 6. [55 Jump Game](https://leetcode.com/problems/jump-game/) — greedy
- [ ] 7. [39 Combination Sum](https://leetcode.com/problems/combination-sum/) — backtracking
- [ ] 8. [236 LCA of a Binary Tree](https://leetcode.com/problems/lowest-common-ancestor-of-a-binary-tree/) — tree DFS
- [ ] 9. [200 Number of Islands](https://leetcode.com/problems/number-of-islands/) — graph flood fill
- [ ] 10. [207 Course Schedule](https://leetcode.com/problems/course-schedule/) — topological sort
- [ ] 11. [146 LRU Cache](https://leetcode.com/problems/lru-cache/) — design
- [ ] 12. [322 Coin Change](https://leetcode.com/problems/coin-change/) — DP knapsack
- [ ] 13. [1143 Longest Common Subsequence](https://leetcode.com/problems/longest-common-subsequence/) — DP two-sequence
- [ ] 14. [300 Longest Increasing Subsequence](https://leetcode.com/problems/longest-increasing-subsequence/) — DP LIS

---

## Trigger index

What you *see* in the prompt → what you *reach for*. This is the recognition layer — the
first thing you lose and the most valuable to reload.

| When you see… | Pattern | Canonical |
|---|---|---|
| sorted array, pair/triple summing to target, palindrome check, "container" | Two pointers (ends) | 3Sum |
| in-place remove/dedup, partition array | Two pointers (fast/slow) | 26 |
| longest/shortest/count **contiguous** sub-array/string under a constraint | Sliding window | 209, 3 |
| sub-array sum **equals / divisible by** K, count of such | Prefix sum + hashmap | 560 |
| next greater/smaller element, spans, histogram | Monotonic stack | 496 |
| parentheses, expression eval, nested decode | Stack (parse/eval) | 394, 227 |
| kth largest/smallest, k closest, merge k lists, streaming median | Heap / top-K | 215, 373 |
| overlapping intervals, scheduling, merge ranges | Intervals (sort) | 56, 435 |
| "min steps / max reach / can you", local choice feels safe | Greedy | 55, 134 |
| enumerate **all** subsets/combos/permutations, "find all" | Backtracking | 78, 39, 46 |
| word/path search in a grid, sudoku, place-and-validate | Backtracking (grid) | 79 |
| depth, diameter, path sum, validate, LCA | Tree DFS (return info up) | 543, 236 |
| level-by-level, right-side view, width | Tree BFS | 199 |
| anything "BST" — kth, validate, range | BST (in-order = sorted) | 230, 98 |
| build tree from traversals | Tree construction | 105 |
| islands/regions, multi-source spread (rot, distance) | Grid BFS/DFS | 200, 994 |
| ordering with prerequisites, DAG cycle | Topological sort | 207, 210 |
| "are these connected", grouping, merge accounts | Union-Find | 547, 721 |
| min-cost weighted path, K-stop, connect-all-points (MST) | Dijkstra / Prim | 787, 1584 |
| prefix queries, autocomplete, word dictionary | Trie | 208, 211 |
| count bits, single number, subset via mask, missing number | Bit manipulation | 338, 268 |
| max/ways along a sequence, dp[i] from dp[i-1/i-2] | DP linear | 198, 53, 91 |
| pick items to hit target sum/count, coins, partition | DP knapsack / subset-sum | 322, 416 |
| two strings/arrays, edit/LCS/interleave | DP two-sequence | 1143, 72 |
| palindromic substrings/subseq, largest square | DP substring | 647, 516, 221 |
| paths / min-cost through a grid | DP grid | 62, 64, 120 |
| tree + "rob / include-exclude" | DP on tree | 337 |
| buy/sell stock with states (cooldown, fee) | DP state machine | 309, 121 |
| increasing / chain subsequence | DP LIS family | 300, 368 |
| "implement a class that…" | Design | 146, 208, 981 |

---

## Patterns

Each: **trigger · technique · canonical · key insight · backups**. Grade 🟢🟡🔴.

### Arrays & strings

**Two pointers (opposite ends)** — sorted, pair/triple/target, palindrome.
Canonical: **15. 3Sum**. Insight: sort, fix `i`, two-pointer the rest; skip duplicates on all
three indices or you'll double-count. Backups: 11 Container With Most Water, 167 2-Sum II, 680 Valid Palindrome II, 42 Trapping Rain Water.

**Two pointers (fast/slow, same direction)** — in-place remove/dedup.
Canonical: **26. Remove Duplicates from Sorted Array**. Insight: slow = write cursor, fast = scan; write only when value is new. Backups: 27 Remove Element, 283 Move Zeroes.

**Sliding window** — longest/shortest/count contiguous under a constraint.
Canonical: **209. Min Size Subarray Sum** + **3. Longest Substring Without Repeating**.
Insight: expand `right`; while window invalid, shrink `left`; record at each step. For
"exactly K distinct/sum" use `atMost(K) - atMost(K-1)`. See [sliding-window template](#templates).
Backups: 424 Longest Repeating Char Replacement, 1004 Max Consecutive Ones III, 76 Min Window Substring.

**Prefix sum + hashmap** — subarray sum equals / divisible by K.
Canonical: **560. Subarray Sum Equals K**. Insight: running sum; `count += seen[sum - k]`,
then `seen[sum]++`. For divisible-by-K, key on `sum % k` (normalize negatives: `(x%k+k)%k`).
Seed `seen[0] = 1`. Backups: 974 Subarray Sums Divisible by K, 523 Continuous Subarray Sum, 1590 Make Sum Divisible by P.

### Stack & heap

**Monotonic stack** — next greater/smaller, spans.
Canonical: **496. Next Greater Element I** (+ 739 Daily Temperatures if you know it). Insight:
stack holds indices; while current breaks the monotonic order, pop and resolve the popped one.

**Stack (parse / eval)** — parentheses, expressions, nested decode.
Canonical: **394. Decode String** + **227. Basic Calculator II**. Insight: push the current
context on `[` / operator, resolve on `]` / end of token. Backups: 20 Valid Parens, 150 RPN, 155 Min Stack.

**Heap / top-K / k-way merge** — kth, k closest, merge k, median.
Canonical: **215. Kth Largest** + **373. K Pairs Smallest Sums**. Insight: size-`k` heap
(min-heap to keep the k *largest*); for k-way merge push `(val, i, j)` and expand neighbors.
Median-of-stream = two heaps. Backups: 973 K Closest Points, 692 Top K Frequent Words, 295 Find Median from Data Stream.

### Intervals & greedy

**Intervals** — overlapping ranges, scheduling, merge.
Canonical: **56. Merge Intervals** + **435. Non-overlapping**. Insight: sort by **start** to
merge; sort by **end** for greedy "keep the most / remove the fewest". Backups: 57 Insert Interval, 452 Min Arrows, 729 My Calendar I.

**Greedy** — "min ops / max reach / can you", local choice is safe.
Canonical: **55. Jump Game** + **134. Gas Station**. Insight: track farthest reach (Jump) or
running tank with a reset point (Gas). Prove the local choice can't hurt before trusting it.
Backups: 45 Jump Game II, 763 Partition Labels, 846 Hand of Straights, 1899 Merge Triplets, 881 Boats.

### Backtracking

**Subsets / combinations / permutations** — enumerate *all*.
Canonical: **78. Subsets** + **39. Combination Sum** + **46. Permutations**. Insight:
choose → recurse → un-choose. Combos pass a `start` index to avoid reorderings; permutations
use a `used[]` set. Sort + skip equal siblings to dedup (40, 90). See [backtracking template](#templates).
Backups: 90 Subsets II, 40 Combination Sum II, 47 Permutations II, 22 Generate Parens, 131 Palindrome Partitioning, 17 Letter Combinations.

**Backtracking on a grid** — word search, place-and-validate.
Canonical: **79. Word Search**. Insight: DFS, mark cell visited in place, restore on the way
out. Backups: 212 Word Search II (Trie), 36/37 Sudoku.

### Trees

**Tree DFS (return info upward)** — depth, diameter, path sum, validate, LCA.
Canonical: **543. Diameter** + **236. LCA**. Insight: recurse, combine children's returns,
return one value up while updating a global (diameter, max path). LCA: node where left and
right both return non-null. Backups: 112/113 Path Sum, 124 Max Path Sum, 98 Validate, 235 LCA-BST.

**Tree BFS (level order)** — level-by-level, right view, width.
Canonical: **199. Right Side View**. Insight: queue; loop `for _ in range(len(queue))` to peel
exactly one level. Backups: 107 Level Order II, 662 Max Width, 637 Average of Levels.

**BST property** — kth, validate, range; "BST" in the title.
Canonical: **230. Kth Smallest in BST** + **98. Validate BST**. Insight: **in-order traversal
of a BST is sorted** — kth smallest is the kth in-order node. Validate by passing `(low, high)`
bounds down, not by checking neighbors. Backups: 99 Recover BST, 501 Mode, 783 Min Distance.

**Tree construction** — build from traversals.
Canonical: **105. Build from Preorder + Inorder**. Insight: `preorder[0]` is the root; find it
in inorder to split left/right subtree sizes; recurse. Backups: 654 Max Binary Tree, 108 Sorted Array → BST.

### Graphs

**Grid BFS/DFS (flood fill)** — islands, regions, multi-source spread.
Canonical: **200. Number of Islands** + **994. Rotting Oranges**. Insight: DFS/BFS marking
visited; **multi-source** problems (rot, 0/1 distance) seed *all* sources into the queue at
once, then BFS outward. Backups: 695 Max Area, 417 Pacific Atlantic, 542 01 Matrix, 733 Flood Fill.

**Topological sort** — prerequisites / DAG ordering, cycle detect.
Canonical: **207. Course Schedule** + **210. Course Schedule II**. Insight: Kahn's — compute
in-degrees, queue the zeros, peel and decrement; if processed < N there's a cycle. Backups: 851 Loud and Rich.

**Union-Find** — connectivity, grouping, "connected?".
Canonical: **547. Number of Provinces** + **721. Accounts Merge**. Insight: `find` with path
compression, `union` by rank; count distinct roots. See [union-find template](#templates).
Backups: 1061 Smallest Equivalent String, 684 Redundant Connection.

**Shortest path / MST** — weighted min-cost, K-stop, connect-all.
Canonical: **787. Cheapest Flights Within K Stops** + **1584. Min Cost Connect Points** (Prim's MST).
Insight: heap of `(cost, node, …)`; Dijkstra pops the cheapest frontier; Prim grows the tree by
cheapest crossing edge. Bellman-Ford (relax E edges K times) when there's a hop limit. See [Dijkstra template](#templates).
Backups: 743 Network Delay, 1631 Path With Min Effort, 2812 Safest Path.

### Trie & bits

**Trie** — prefix queries, autocomplete, word dictionary.
Canonical: **208. Implement Trie** + **211. Add and Search Words** (wildcards). Insight:
`children` dict + `is_end` flag; `.` wildcard = recurse into all children. Backups: 1268 Search Suggestions, 212 Word Search II.

**Bit manipulation** — count bits, single number, mask subsets, missing.
Canonical: **338. Counting Bits** + **268. Missing Number**. Insight: `x & (x-1)` clears the
lowest set bit; XOR cancels pairs; `dp[i] = dp[i>>1] + (i&1)`. Backups: 191 Number of 1 Bits, 136 Single Number.

### Dynamic programming

**DP linear** — max/ways along a sequence, `dp[i]` from `dp[i-1]/dp[i-2]`.
Canonical: **198. House Robber** + **53. Maximum Subarray** (Kadane) + **91. Decode Ways**.
Insight: `dp[i]` = best *ending at / using* `i`; usually collapses to two rolling vars. Kadane:
`cur = max(x, cur + x)`. Decode Ways: like climbing stairs but each step is gated by a validity check.
Backups: 70 Climbing Stairs, 746 Min Cost Climbing, 152 Max Product Subarray, 740 Delete and Earn, 213 House Robber II.

**DP knapsack / subset-sum** — pick items to hit a target sum/count.
Canonical: **322. Coin Change** + **416. Partition Equal Subset Sum**. Insight: dp over
(items, capacity). **Combinations** → loop items outer, target inner. **Permutations** → loop
target outer, items inner (that's the whole difference between 518 and 377). Backups: 518 Coin Change 2, 377 Combination Sum IV, 494 Target Sum, 474 Ones and Zeroes, 698 Partition to K.

**DP two-sequence** — two strings/arrays.
Canonical: **1143. Longest Common Subsequence** + **72. Edit Distance**. Insight: 2D `dp[i][j]`;
on match take `dp[i-1][j-1]+1`, else combine the neighbor states (the combine rule *is* the problem).
Backups: 583 Delete Operation, 712 Min ASCII Delete Sum, 97 Interleaving String, 718 Max Length Repeated Subarray.

**DP substring / palindrome / square**.
Canonical: **647. Palindromic Substrings** + **516. Longest Palindromic Subseq** + **221. Maximal Square**.
Insight: expand-around-center (2n centers) *or* `dp[i][j]` depends on `dp[i+1][j-1]` (fill by
increasing length). **LPS(s) = LCS(s, reversed(s))**. Maximal Square: `dp[i][j] = min(3 neighbors)+1`.

**DP grid paths** — paths / min-cost across a grid.
Canonical: **62. Unique Paths** + **64. Min Path Sum** + **120. Triangle**. Insight: `dp[r][c]`
from top/left; rolls down to a 1D row. Backups: 63 Unique Paths II, 1937 Max Points with Cost, 931 Min Falling Path.

**DP on trees** — tree + include/exclude.
Canonical: **337. House Robber III**. Insight: each node returns `(rob_this, skip_this)`; parent
picks `max` of children's skip when robbing itself. Backups: 124 Max Path Sum, 968 Camera placement.

**DP stock (state machine)** — buy/sell with states.
Canonical: **309. Best Time w/ Cooldown** + **121. Best Time** (one transaction). Insight: model
states `hold / sold / rest`, one rolling var each, write the transitions. Backups: 122 Unlimited, 714 With Fee, 188 At-Most-K.

**DP LIS family** — increasing / chain subsequence.
Canonical: **300. Longest Increasing Subsequence** + **368. Largest Divisible Subset**. Insight:
O(n²) `dp[i] = 1 + max(dp[j] for j<i if a[j]<a[i])`; **O(n log n)** keep a `tails` array and
`bisect_left` to place each value ("fake LIS" — tails isn't a real subsequence but its length is right).
Backups: 673 Number of LIS, 674 Longest Continuous, 334 Increasing Triplet, 1048 Longest String Chain.

### Design

**Design / data-structure** — "implement a class that…".
Canonical: **146. LRU Cache** (the must-do) + **208. Trie** + **981. Time-Based KV Store**.
Insight: LRU = hashmap + doubly linked list, O(1) move-to-front (or `OrderedDict.move_to_end`).
Time-based KV = dict of lists + `bisect` on timestamp. Backups: 1472 Browser History, 155 Min Stack, 284 Peeking Iterator, 362 Hit Counter.

---

## Hard tier

Hard problems rarely need a *new* idea. They're one of:
1. a core pattern with nasty bookkeeping (⚠️),
2. **two or more core patterns composed** (🔥), or
3. one of the ~10 **advanced primitives** below that the core map omits.

So recovery for hards isn't memorizing them — it's reloading these primitives, then practicing
*decomposition*: "which base patterns is this made of?" The table tags each with its parts.

### Advanced primitives (not in the core map)

**Monotonic deque** — window min/max in O(n). Sliding window + a deque kept sorted: pop the back while dominated, pop the front when out of window. → 239 Sliding Window Maximum.

**Two heaps (balanced)** — running median. Max-heap (low half) + min-heap (high half), rebalance to ±1. → 295 Median from Data Stream, 480 Sliding Window Median (+ lazy deletion).

**Trie + DFS/backtracking** — search many words in a grid at once: build a trie, DFS the grid walking the trie. → 212 Word Search II.

**Interval DP** — `dp[i][j]` over a subrange, decided by the *last* or *split* point inside it. → 312 Burst Balloons (iterate the last balloon to pop), 1547 Cut a Stick.

**Bitmask DP** — state = a subset (n ≤ ~20). `dp[mask]` = best over the visited set. → 847 Shortest Path Visiting All Nodes, 698 Partition to K (gentle intro).

**DP + binary search** — sort, then LIS-style placement with `bisect`. → 354 Russian Doll Envelopes, 1235 Max Profit Job Scheduling, and the O(n log n) form of 300.

**Fenwick / Segment tree** — range query + point update in O(log n). → 307 Range Sum Mutable, 315 Count of Smaller Numbers After Self.

**Monotonic stack (hard applications)** — 84 Largest Rectangle in Histogram, 85 Maximal Rectangle, 42 Trapping Rain Water.

**BFS on a state space** — nodes aren't given, you generate them. → 127 Word Ladder, 752 Open the Lock, Min Jumps to Reach Home. (0-1 BFS with a deque when edge weights are 0/1.)

**Advanced graph** — build the graph, then run a known algo. → 269 Alien Dictionary (ordering → edges → topo sort), 332 Reconstruct Itinerary (Hierholzer), Floyd-Warshall for all-pairs.

### Canonical hards — decompose, don't memorize

| Problem | Made of | The twist |
|---|---|---|
| 42 Trapping Rain Water | two pointers / mono-stack | each cell holds `min(maxL, maxR) − height` |
| 239 Sliding Window Maximum | sliding window + mono-deque | deque of indices, kept decreasing |
| 295 Median from Data Stream | two heaps | keep the two halves balanced ±1 |
| 212 Word Search II | grid backtracking + trie | walk the trie instead of one target word |
| 312 Burst Balloons | interval DP | iterate the **last** balloon popped in (i,j) |
| 84 Largest Rectangle | monotonic stack | the pop gives the rectangle's right bound |
| 127 Word Ladder | BFS on states | words are nodes, one-letter edits are edges |
| 297 Serialize/Deserialize Tree | tree DFS + encoding | preorder with explicit null markers |
| 269 Alien Dictionary | graph build + topo sort | each adjacent word pair gives one edge |
| 460 LFU Cache | design | hashmap + freq→DLL buckets + min-freq pointer |
| 10 Regex Matching | DP two-sequence | `*` branches into zero-of vs one-more |
| 329 Longest Increasing Path | grid DFS + memo | it's a DAG, so memoize and skip `visited` |
| 2009 Make Array Continuous 🔥 | sort+dedup + sliding window | fix the max, count how many fit in `[max−n+1, max]` |
| 354 Russian Doll Envelopes | sort + LIS (n log n) | sort width asc, height **desc**, then LIS on height |

Only **interval DP** and **bitmask DP** are genuinely new code shapes — add them to [Templates](#templates)
the first time you hit a 🔴 on one. Everything else reuses patterns you already reloaded.

---

## Templates

The boilerplate you forget the *syntax* of. Copy, don't re-derive.

```python
# Sliding window (variable size) — longest/shortest/count under a constraint
def sliding(s):
    left, best, window = 0, 0, {}            # window = whatever you track
    for right, ch in enumerate(s):
        window[ch] = window.get(ch, 0) + 1
        while invalid(window):               # shrink until valid again
            window[s[left]] -= 1
            left += 1
        best = max(best, right - left + 1)   # or += (right-left+1) to count
    return best
```

```python
# Backtracking skeleton — subsets / combos / permutations
def backtrack(start, path):
    res.append(path[:])                      # or check a goal condition
    for i in range(start, len(nums)):
        if i > start and nums[i] == nums[i-1]: continue   # dedup (sorted input)
        path.append(nums[i])
        backtrack(i + 1, path)               # i (reuse) | i+1 (no reuse) | start=0 + used[] (perms)
        path.pop()
```

```python
# Binary search — leftmost insertion point (handles the off-by-ones)
def lower_bound(a, target):
    lo, hi = 0, len(a)                       # hi exclusive
    while lo < hi:
        mid = (lo + hi) // 2
        if a[mid] < target: lo = mid + 1
        else:               hi = mid
    return lo                                # first index with a[i] >= target
```

```python
# Union-Find with path compression + union by rank
class DSU:
    def __init__(self, n): self.p, self.r = list(range(n)), [0]*n
    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]    # path compression
            x = self.p[x]
        return x
    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra == rb: return False            # already connected (cycle)
        if self.r[ra] < self.r[rb]: ra, rb = rb, ra
        self.p[rb] = ra
        self.r[ra] += self.r[ra] == self.r[rb]
        return True
```

```python
# Dijkstra — min cost from src
import heapq
def dijkstra(graph, src, n):                 # graph[u] = [(v, w), ...]
    dist = [float('inf')] * n
    dist[src] = 0
    pq = [(0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]: continue             # stale entry
        for v, w in graph[u]:
            if d + w < dist[v]:
                dist[v] = d + w
                heapq.heappush(pq, (dist[v], v))
    return dist
```

---

## Carried-over tricks

Hard-won notes from the original list — these are things you *will* re-forget:

- Sort a list by a key that indexes *another* dict/list: `sorted(voted, key=lambda x: d[x], reverse=True)`.
- `list` is unhashable, `tuple` is hashable — use tuples as dict keys / set members.
- Backtracking: have the helper **return** the result, don't thread a mutable state arg.
- `deque.pop` is faster than `deque.popleft`; `heapq.replace(h, x)` beats pop-then-push.
- Sliding-window master template: https://leetcode.com/problems/minimum-window-substring/solutions/26808/
- Knapsack series: https://leetcode.com/discuss/study-guide/1200320/Thief-with-a-knapsack-a-series-of-crimes
- Greedy ABCs: https://leetcode.com/discuss/general-discussion/1061059/ABCs-of-Greedy

---

## Weak set

Patterns/problems you keep failing. Do these **first**, every cycle. (Fill in as you go.)

- [ ] _(empty — populate from 🔴 grades)_
