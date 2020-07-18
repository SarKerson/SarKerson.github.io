---
layout:     post
title:      Go 生态下的 Cache 评测
subtitle:   Caching in Go
date:       2020-07-18
author:     Eric.Y
header-img: img/post-bg-ios9-web.jpg
catalog: true
tags:
    - golang
---

# Caching in Go

本文主要介绍 Go 生态下面比较有名的几个 Cache，剖析这些 Cache 实现的原理，并分析各自存在的不足之处。最后，介绍如何编写 Benchmark 来对比不同的 Cache，方便喜欢造轮子的同学进行测试。

大家第一次接触 Cache，也许都是因为 LeetCode 上面这么一道 LRUCache 的题目。对 LRU 不太了解的同学可以再来做一下这道题目复习复习。

## 1. LRU Cache

```c++
/* 
Design and implement a data structure for Least Recently Used (LRU) cache. It should support the following operations: get and put.
get(key) - Get the value (will always be positive) of the key if the key exists in the cache, otherwise return -1.
put(key, value) - Set or insert the value if the key is not already present. When the cache reached its capacity, it should invalidate the least recently used item before inserting a new item.
Follow up:
Could you do both operations in O(1) time complexity?
Example:
*/
LRUCache cache = new LRUCache(2/* capacity */ );
cache.put(1, 1);
cache.put(2, 2);
cache.get(1);    // returns 1
cache.put(3, 3);   // evicts key 2
cache.get(2);    // returns -1 (not found)
cache.put(4, 4);   // evicts key 1
cache.get(1);    // returns -1 (not found)
cache.get(3);    // returns 3
cache.get(4);    // returns 4
```

最简洁的实现

```py
class LRUCache:
  def __init__(self, capacity: int):
    self.lru = OrderedDict()
    self.cap = capacity
  def get(self, key: int) -> int:
    if key not in self.lru:
      return -1
    # move to the end
    self.lru.move_to_end(key)
    return self.lru[key]
  def put(self, key: int, value: int) -> None:
    if len(self.lru) == self.cap and key not in self.lru:
      # pop the front item
      self.lru.popitem(last=False)
    elif key in self.lru:
      self.lru.move_to_end(key)
    self.lru[key] = value
```

## 2. 并发支持

原生的 LRU Cache 显然不是并发安全的，因为每次 get 或者 set 都涉及到了链表节点移动的操作。要使得 LRU Cache 并发安全，最简单暴力的做法是，直接对整个 LRU Cache  加锁，每次 put、get 都需要 lock 一下，例如 1.8k stars 的 https://github.com/hashicorp/golang-lru，以及基于该库进行二层封装的其他共用库。代码差不多长这样子：

```go
func (l *lockedCache) Add(key, value interface{}, expiresAt time.Time) {
    l.m.Lock()
    l.c.Add(key, value, expiresAt)
    l.m.Unlock()
}
func (l *lockedCache) Get(key interface{}) (interface{}, bool) {
    l.m.Lock()
    v, f := l.c.Get(key)
    l.m.Unlock()
    return v, f
}
```

这样导致的问题是，当并发 Get 操作很多的时候，Get 操作已经变成串行。也就说对整个 Cache 进行加锁是不明智的。

### 解决1：分桶

将一个 hashtable 根据 key 拆分成多个 hashtable，每个 hashtable 对应一个锁，锁粒度更细，冲突的概率也就更低了。

![img](https://i.ibb.co/6mxr7dS/1.png)

### 解决2：延缓提权

对于 get 操作，原生 LRU Cache 每次都会有一次 move_to_front 的操作，因此每次 get 都会涉及整个 cache 的加锁操作，这会给 cache 的性能大打折扣。

解决方案是，为每个 Item 都维护一个访问计数 promotions ，当且仅当 promotions 达到阈值的时候，才触发 move_to_front 操作。

## 3. 几个实现

### 3.1. BigCache

[BigCache](https://github.com/allegro/bigcache) 根据键值的 hash 将数据分散到多个分片上面进行存储，实现了解决方案一，并根据 Golang 的 GC 做了优化。每个分片的底层存储结构是一个环形缓冲区 entries， 并维护一个 key 到缓冲区 index 的映射。

#### Cache 的定义

```go
type BigCache struct {
  shards    []*cacheShard  // 分片
  lifeWindow  uint64     // 过期时间
  clock     clock
  hash     Hasher     // 实现了hash算法的interface，所以可以自定义hash
  config    Config
  shardMask   uint64
  maxShardSize uint32
  close     chan struct{}
}
```

#### Shard 的定义

```go
type cacheShard struct {
  hashmap   map[uint64]uint32  // 存储在环形缓冲区 entries 中的元素的 index
  entries   queue.BytesQueue   // 实际存储内容的 byte 数组，是个ring buffer
  lock     sync.RWMutex     // shard的全局锁
  entryBuffer []byte        // 预分配的一段内存
  onRemove   onRemoveCallback
  isVerbose  bool
  logger   Logger
  clock    clock
  lifeWindow uint64
  hashmapStats map[uint64]uint32
  stats Stats           // 统计信息
}
```

每个 shard 的结构如图所示。在 BigCache 的实现中，map 的 key 为原始 key 的哈希值 (uint64)，value 则为一个 int 类型的 index。其中，index 对应底层 ByteQueue 中的某个位置，在读取操作时，BigCache 从 ByteQueue 中取出序列化的 [] byte 片段，从而还原出 value 信息。

![img](https://i.ibb.co/NYKQ5Vq/2.png)

#### Set 操作

每当 set 一个新元素的时候，会把 value 序列化后塞进环形缓冲区 entries，然后记录 key 及 value 存储的  index 到 hashmap 中。如果 key 对应的 entry 已经在 entries 中，则之前的 entry 会被 reset。

```go
func (s *cacheShard) set(key string, hashedKey uint64, entry []byte) error {
 currentTimestamp := uint64(s.clock.epoch())
 s.lock.Lock()
 // 1. 查找是否已经存在了对应的缓存对象，如果存在，将它的值置为空
 if previousIndex := s.hashmap[hashedKey]; previousIndex != 0 {
  if previousEntry, err := s.entries.Get(int(previousIndex)); err == nil {
   resetKeyFromEntry(previousEntry)
  }
 }
 // 2. 取出最老的缓存对象，判断是否要过期，是的话则淘汰
 if oldestEntry, err := s.entries.Peek(); err == nil {
  s.onEvict(oldestEntry, currentTimestamp, s.removeOldestEntry)
 }
 // 将对象放入到一个字节数组中
 w := wrapEntry(currentTimestamp, hashedKey, key, entry, &s.entryBuffer)
 for {
  // 放入到字节队列中
  if index, err := s.entries.Push(w); err == nil {
   s.hashmap[hashedKey] = uint32(index)
   s.lock.Unlock()
   return nil
  }
  // 3. 如果空间不足，移除最老的元素
  if s.removeOldestEntry(NoSpace) != nil {
   s.lock.Unlock()
   return fmt.Errorf("entry is bigger than max shard size")
  }
 }
}
```

一个潜在的问题是，上述做法相当于把 map 的 GC 压力转到了 slice (array)，是否真的能带来性能上的提升？事实上，在 golang 中，不存在释放部分数组的情况，即数组的内存管理有两种情况：1. 全部释放；2. 继续保留。因此，对于数组的 GC 时间复杂度可理解为 O (1) 时间。详见 https://golangbot.com/arrays-and-slices/ 

#### Get 操作

get 操作比较简单，根据 hashedKey 获取 itemIndex（环形 buffer 中的 offset），然后根据 itemIndex 获取 entry（即我们存储的序列化的对象）。不过，注意这里有一个对 key 值的二次判断，因为 hash 冲突的存在，实际存储的 key 可能并不一致。

```go
func (s *cacheShard) get(key string, hashedKey uint64) ([]byte, error) {
  s.lock.RLock()
  itemIndex := s.hashmap[hashedKey]
  if itemIndex == 0 {
    s.lock.RUnlock()
    s.miss()
    return nil, ErrEntryNotFound
  }
  // 根据 index 取出 entry 的 header 信息
  wrappedEntry, err := s.entries.Get(int(itemIndex))
  if err != nil {
    s.lock.RUnlock()
    s.miss()
    return nil, err
  }
  if entryKey := readKeyFromEntry(wrappedEntry); key != entryKey { // 由于对于冲突的key只会存储最近的一个，所以当hash值一样时还要具体在看key是不是想要的key
    if s.isVerbose {
      s.logger.Printf("Collision detected. Both %q and %q have the same hash %x", key, entryKey, hashedKey)
    }
    s.lock.RUnlock()
    s.collision()
    return nil, ErrEntryNotFound
  }
  // 根据 header 信息取出实际存储的 entry
  entry := readEntry(wrappedEntry)
  s.lock.RUnlock()
  s.hit()
  return entry, nil
}
```

#### 小结

##### 缓存策略

不是，其实是 FIFO。每次 set 会把新元素放到后面，如果有冲突，则把先前的元素删除。get 操作仅仅是一个读操作，读到非过期则返回。

##### 驱逐策略

BigCache 的驱逐策略有三个。

- 首先，在增加一个元素之前，会检查最老的元素要不要删除。过期则删除

- 其次，在添加一个元素失败后，会清理空间删除最老的元素。

- 同时， 还会专门有一个定时的清理 goroutine, 负责移除过期数据。

##### 槽点

- Set 相同的 key 会导致 BigCache  出现气泡，因为 BigCache 没有尝试重复利用这些空间。

- BigCache 使用的是 FIFO 策略，因此对于一般的 Zipf 分布请求不友好

##### 优点

- Get 请求是无锁的，非常快

- 无 GC 压力

### 3.2 **FreeCache**

FreeCache 将 Cache 切成 256 个 Segment，每个 Segment 包含 256 个 slot 以及一个 ringbuffer 来存放具体数据，每个 slot 可以存放多个 entry，指向 ringbuffer 中存放的 item 具体位置。当 add 一个元素时，首先会由 LSB(hash)[:8] 定位到某个 segment，并由 LSB(hash)[8:16] 定位到该 segment 下面的 slot。每个 slot 按 hash 递增的顺序存储多个 entryPtr（不使用 hashMap 应该是基于节约空间以及冲突的考虑）。

#### Cache 的定义

```go
type Cache struct {
    locks   [segmentCount]sync.Mutex
    segments [segmentCount]segment
}
```

#### Segment 的定义

```go
// a segment contains 256 slots, a slot is an array of entry pointers ordered by hash16 value
// the entry can be looked up by hash value of the key.
type segment struct {
    rb       RingBuf // ring buffer that stores data
    segId     int
    _       uint32
    // ... 一些统计值
    vacuumLen   int64    // up to vacuumLen, new data can be written without overwriting old data.
    slotLens    [256]int32 // The actual length for every slot.
    slotCap    int32    // max number of entry pointers a slot can hold.
    slotsData   []entryPtr // shared by all 256 slots
}
// entry pointer struct points to an entry in ring buffer
type entryPtr struct {
    offset  int64  // entry offset in ring buffer
    hash16  uint16 // entries are ordered by hash16 in a slot.
    keyLen  uint16 // used to compare a key
    reserved uint32
}
```

![img](https://i.ibb.co/KXFrGt6/3.png)

#### Set 操作

```go
func (cache *Cache) Set(key, value []byte, expireSeconds int) (err error) {
 // 获取 segID 以及 slotID
 // 对 segment 加锁
 slot := seg.getSlot(slotId) // []entryPtr
 idx, match := seg.lookup(slot, hash16, key)
 // 如果冲突的话，旧空间足够则直接覆盖，否则标记删除旧空间
 if match {
  // 如果老的 entry 空间足够容得下新的 entry 的话，则 in-place 修改，return
  if hdr.valCap >= hdr.valLen {
    // 更新 header 以及 value，key 不变
    seg.rb.WriteAt(hdrBuf[:], matchedPtr.offset)
    seg.rb.WriteAt(value, matchedPtr.offset+ENTRY_HDR_SIZE+int64(hdr.keyLen))
    return
  }
  // 否则，在 ringbuff 中标记删除该 entry，在 slot 中直接把该 entryPtr 删除
  seg.delEntryPtr(slotId, slot, idx)
  // ...
 }
 // 对该 slot 执行写时驱逐策略，当且仅当剩余空间不够才进行驱逐
 seg.evacuate(entryLen, slotId, now)
 // 写入 ringbuff 以及 entryPtr
 seg.insertEntryPtr(slotId, hash16, seg.rb.End(), idx, hdr.keyLen)
 seg.rb.Write(hdrBuf[:])
 seg.rb.Write(key)
 seg.rb.Write(value)
 seg.rb.Skip(int64(hdr.valCap - hdr.valLen))
```

#### 写时驱逐策略

```go
for seg.vacuumLen < entryLen {
 oldHdr := // 取出队首
 // 1. 如果队首被标记删除
 if oldHdr.deleted {
  // 则将该空间添加到可利用空间
  continue
 }
 // 2. 已经过期
 expired := oldHdr.expireAt != 0 && oldHdr.expireAt < now
 // 3. 该 entry 的访问时间小于整个 segment 的平均访问时间（近 LRU 策略）
 leastRecentUsed := int64(oldHdr.accessTime)*atomic.LoadInt64(&seg.totalCount) <= atomic.LoadInt64(&seg.totalTime)
 if expired || leastRecentUsed || consecutiveEvacuate > 5 {
  // 标记删除，并将可利用空间回收
  seg.delEntryPtrByOffset(oldHdr.slotId, oldHdr.hash16, oldOff)
  seg.vacuumLen += oldEntryLen
 } else {
  // 将队首移到队尾，更新 slot 的 entryPtr 信息，提高命中率
  newOff := seg.rb.Evacuate(oldOff, int(oldEntryLen))
  seg.updateEntryPtr(oldHdr.slotId, oldHdr.hash16, oldOff, newOff)
 }
}
```

#### Get 操作

```go
func (cache *Cache) Get(key []byte) (value []byte, err error) {
  if key的哈希值不存在:
    return nil, ErrNotFound
  if 对应的entry已过期:
    delete entry
    return nil, ErrNotFound
  else:
    update entry_header   
  读取entry中的value
  return value, nil
}
```

BTW，FreeCache 还做了内存对齐优化，详见： https://go101.org/article/memory-layout.html，https://ms2008.github.io/2019/08/01/golang-memory-alignment/

#### 小结

##### 槽点

- 没有独立的 goroutine 来进行驱逐，相当于把驱逐的压力都放在了 set 操作的时候（可能是害怕独立的 goroutine 对锁持有时间的不可控制性？）

##### 优点

- 近 LRU 策略

- 尝试对老空间的再利用

- 内存对齐优化

##### 提权策略

提权是通过修改 entry 的过期时间实现的（用于近似 LRU 驱逐）

##### 驱逐策略

驱逐策略主要有三个：

- 被标记删除的（set 的时候发现相同 key 的旧 entry；get的时候发现 expired 的 entry）

- 已经过期的

- entry 的访问时间小于整个 segment 的平均访问时间

### 3.3 CCache

主要实现了解决方案 1、2。

#### Item 的结构

```go
type Item struct {
    key     string
    group    string
    promotions int32    // 计数窗口
    refCount  int32
    expires   int64
    size    int64
    value    interface{}
    element   *list.Element
}
```

#### Cache 的定义

```go
type Cache struct {
    *Configuration
    list     *list.List // LRU
    size     int64
    buckets   []*bucket  // entrys
    bucketMask  uint32
    deletables  chan *Item
    promotables chan *Item
    control   chan interface{}
}
```

#### Bucket 的结构

```go
type bucket struct {
    sync.RWMutex
    lookup map[string]*Item
}
func (b *bucket) get(key string) *Item {
    b.RLock()
    defer b.RUnlock()
    return b.lookup[key]
}
func (b *bucket) set(key string, value interface{}, duration time.Duration) (*Item, *Item) {
    expires := time.Now().Add(duration).UnixNano()
    item := newItem(key, value, expires)
    b.Lock()
    existing := b.lookup[key]
    b.lookup[key] = item
    b.Unlock()
    return item, existing
}
```

#### Set 操作

```go
func (c *Cache) set(key string, value interface{}, duration time.Duration) *Item {
    item, existing := c.bucket(key).set(key, value, duration)
    if existing != nil {
        // 删除先前含有相同 key 的 item
        c.deletables <- existing
    }
    // 提权
    c.promote(item)
    return item
}
func (c *Cache) promote(item *Item) {
    c.promotables <- item
}
```

![img](https://i.ibb.co/XyB2dmL/6.png)

#### Get 操作

```go
// Get an item from the cache. Returns nil if the item wasn't found.
// This can return an expired item. Use item.Expired() to see if the item
// is expired and item.TTL() to see how long until the item expires (which
// will be negative for an already expired item).
func (c *Cache) Get(key string) *Item {
    item := c.bucket(key).get(key)
    if item == nil {
        return nil
    }
    // 没有过期，则提权
    if item.expires > time.Now().UnixNano() {
        c.promote(item)
    }
    return item
}
```

![img](https://i.ibb.co/qRFbnhS/7.png)

#### 清道夫协程

在 new 一个 cache 的时候，会起一个独立的 goroutine 来处理需要提权、删除的 Item：

```go
func (c *Cache) worker() {
    defer close(c.control)
    dropped := 0
    for {
        select {
        case item, ok := <-c.promotables:
            if ok == false {
                goto drain
            }
            if c.doPromote(item) && c.size > c.maxSize {
                dropped += c.gc()
            }
        case item := <-c.deletables:
            c.doDelete(item)
        case control := <-c.control:
            switch msg := control.(type) {
            case getDropped:
                msg.res <- dropped
                dropped = 0
            case setMaxSize:
                c.maxSize = msg.size
                if c.size > c.maxSize {
                    dropped += c.gc()
                }
            }
        }
    }
drain:
    for {
        select {
        case item := <-c.deletables:
            c.doDelete(item)
        default:
            close(c.deletables)
            return
        }
    }
}
```

#### 小结

CCache 主要使用了延缓提权、分桶策略，来减少并发获取 key 的锁冲突，实现非常简单。

但是底层仍然使用指针，避免不了 GC 压力。

### 3.4 **BenchMark**

这里直接引用 DGraph 的一篇评测结果。该文章对比了 BigCache、FreeCache 以及 GroupCache 在只读、只写、混合读写的性能对比。

#### 只读

在只读场景下，BigCache 性能最优，因为在 BigCache 中对分片用了读写锁，所以只读场景下是无锁的。而 FreeCache 以及 GroupCache 在读场景下都需要对分片进行操作，因此加了 mutex，因此性能次于 BigCache。

![img](https://i.ibb.co/fDGQQt1/8.png)

#### 只写

在只写场景下，三者性能差别不大，但是 FreeCache 性能更优。

![img](https://i.ibb.co/9g4TCp8/4.png)

#### 混合读写 (25% writes, 75% reads)

看起来只有 BigCache 对并发友好。

![img](https://i.ibb.co/XDC7BbX/5.png)

#### Zipf 分布缓存命中率

什么是 Zipf 分布？它可以表述为：在[自然语言](https://zh.wikipedia.org/wiki/自然语言)的[語料庫](https://zh.wikipedia.org/wiki/語料庫)裡，一个单词出现的频率与它在频率表里的排名成[反比](https://zh.wikipedia.org/wiki/反比)，说人话则是，出现频率高的，则更容易被访问，比如搜索结果、淘宝销量排名等等。放在请求的场景下则是，热门内容越容易被请求。

| CACHE SIZE (# OF ELEM) | 10000 | 100000 | 1000000 | 10000000 |
| ---------------------- | ----- | ------ | ------- | -------- |
| BigCache               | -     | 37%    | 52%     | 55%      |
| FreeCache              | -     | 38%    | 55%     | 90%      |
| GroupCache             | 29%   | 40%    | 54%     | 90%      |

FreeCache 和 GroupCache 都作了近 LRU 策略，而 BigCache 相当于 FIFO，因此 BigCache 对于 Zipf 分布的请求不够友好，原因如下：

- BigCache 没有充分利用 buffer 的空间，如果有大量相同的 key 写入的话，会导致 ringbuffer 中存在相同的 key，并且产生气泡。

- BigCache 没有在 get 的时候对 entry 进行提权，有可能导致最近访问的 key 被驱逐

## 4. 编写 Benchmark

每当完成一个轮子，我们必须和业界其他轮子进行 PK。如果仅仅弄一个能跑的轮子，那还不简单，重要的是看谁能有更强的 performance，在 PK 中发现自己的不足，吸收别人的优点，才能造出更强的轮子。

下面的 benchmark 来自 https://github.com/dgraph-io/benchmarks/blob/master/cachebench/cache_bench_test.go，我们只需要实现我们自己的 Cache 的测试接口即可。下面例子是 CCache：

```go
type CCache struct {
  c *ccache.Cache
}
func (r *CCache) Get(key []byte) ([]byte, error) {
  item := r.c.Get(string(key))
  if item == nil {
   return nil, errKeyNotFound
  } else {
   return item.Value().([]byte), nil
  }
}
func (r *CCache) Set(key, value []byte) error {
  r.c.Set(string(key), value, 10*time.Second)
  return nil
}
func newCCache(keysInWindow int) *CCache {
  cc := ccache.New(ccache.Configure().MaxSize(int64(keysInWindow)).ItemsToPrune(500))
  return &CCache{cc}
}
```

下面是结果

```
BenchmarkCaches/CCacheZipfMixed-4         5214476        252 ns/op        28 B/op      2 allocs/op
BenchmarkCaches/FastCacheZipfMixed-4       12887888         89.0 ns/op       6 B/op      0 allocs/op
BenchmarkCaches/FreeCacheZipfMixed-4       21327250         59.1 ns/op       1 B/op      0 allocs/op
BenchmarkCaches/GroupCacheZipfMixed-4       9320209        118 ns/op        13 B/op      0 allocs/op
BenchmarkCaches/CCacheOneKeyMixed-4        2775771        449 ns/op        22 B/op      2 allocs/op
BenchmarkCaches/CCacheZipfRead-4         7524876        143 ns/op        16 B/op      2 allocs/op
BenchmarkCaches/FastCacheZipfRead-4       17824086         64.9 ns/op       7 B/op      0 allocs/op
BenchmarkCaches/FreeCacheZipfRead-4       28711682         60.4 ns/op       1 B/op      0 allocs/op
BenchmarkCaches/GroupCacheZipfRead-4       10563777        126 ns/op        0 B/op      0 allocs/op
```

## 5. 展望

缓存有很多种，本文只介绍了 Golang 生态下几个著名的 Cache，其中 FreeCache 跟 CCache 是 LRU 策略，而 BigCache 是 FIFO 策略。但是仍然可以有更好的淘汰策略值得探索，例如 Java 生态下非常有名的 Caffeine，使用了 Tiny-LRU（作者声称已经接近最优解），但是似乎 Golang 生态下的经过工业级验证过的使用其他更优淘汰策略的 Cache 还是欠缺的。

## 6. Reference

- https://www.openmymind.net/Shard-Your-Hash-table-to-reduce-write-locks/

- https://www.openmymind.net/High-Concurrency-LRU-Caching/

- http://highscalability.com/blog/2016/1/25/design-of-a-modern-cache.html

- https://dgraph.io/blog/post/caching-in-go/

- https://go101.org/article/memory-layout.html，https://ms2008.github.io/2019/08/01/golang-memory-alignment/

- https://github.com/dgraph-io/benchmarks/tree/master/cachebench

- https://blog.golang.org/ismmkeynote
