---
layout:     post
title:      Elasticsearch 概览
subtitle:   Elasticsearch - An Overview
date:       2021-01-30
author:     Eric.Y
catalog: true
tags:
    - database
---

# Elasticsearch - An Overview

> TL;DR; 本文从分布式架构、数据读写、应用场景对 Elasticsearch 做一个概括性介绍，让读者了解 ES 是什么，能在哪些场景应用，为什么 ES 这么快。

# Introduction

这个世界已然被数据淹没，但是如果数据只是躺在磁盘里面根本就毫无用处。Elasticsearch（ES）是一个分布式、可扩展、文档存储、实时的搜索与数据分析引擎。 它能从落库开始就赋予你的数据以检索、搜索、分析的能力。Elasticsearch 基于 Lucene。
Lucene 可以说是当下最先进、高性能、全功能的搜索引擎库—无论是开源还是私有。
Elasticsearch 底层依赖 Lucene，通过隐藏 Lucene 的复杂性，取而代之的提供一套简单一致的 RESTful API。

# Concept

首先看下 ES 文档存储的几个重要概念：

| **名称**   | **概念** | **对应关系型数据库概念** | **说明**                                                                   |
| -------- | ------ | -------------- | ------------------------------------------------------------------------ |
| index    | 索引     | Database       | 具有相似特点的文档的集合，可以对应为关系型数据库中的数据库，通过名字在集群内唯一标识                               |
| type     | 文档类别   | Table          | 索引内部的逻辑分类，可以对应为 Mysql 中的表                                                |
| document | 文档     | Row            | 构成索引的最小单元，属于一个索引的某个类别，从属关系为： Index -> Type -> Document，通过 id 在Type 内唯一标识 |
| field    | 字段     | Column         | 构成文档的单元                                                                  |

然后是 ES 集群相关几个重要概念：

| **名称**  | **概念** | **说明**                                                      |
| ------- | ------ | ----------------------------------------------------------- |
| cluster | 集群     | 一个或多个 Node 的集合，ES 可以通过跨集群的备份，来提高服务稳定性                       |
| Node    | 节点     | 运行 ES 的单个实例，保存数据并具有索引和搜索的能力，可以包含多个 Shard                    |
| Shard   | 分片     | 索引分为多个块，每块叫做一个 Shard。索引定义时需要指定分片数且不能更改（因为再分片相当于重建索引）。       |
| Replica | 分片的备份  | 每个分片默认一个 Replica，它可以提升节点的可用性，同时能够提升搜索时的并发性能（搜索可以在全部分片上并行执行） |

# Distributed Architecture

## Data Replication

ES 为主备架构，即 Shard 分为 Primary Shard 及 Replica Shard，写请求走 Primary Shard，读请求则均衡打到所有 Shard，Replica Shard 的数据从 Primary Shard 同步。
下图是含有 3 个 Node 的集群：
![](https://tech-proxy.bytedance.net/tos/images/1614694387246_13f3040b660770188c1e520890d0d88f)

-   蓝色部分：有 3 个 Shard，分别是 P1，P2，P3，位于 3 个不同的 Node 中，这里没有 Replica
-   绿色部分：有 2 个 Shard，分别是 P1、P2，位于 2 个不同的 Node 中，每个 Shard 都有一个 Replica Shard，分别是 R1，R2。基于可用性考虑，同一个 Shard 的 Primary 和 Replica 节点不能处于同一个 Node 中。这里 Shard1 的 P1 和 R1 分别位于 Node3 和 Node2 中，如果某一刻 Node2 发生宕机，服务基本不会受影响，因为还有一个 P1 和 R2 都还是可用的。因为是主备架构，当主分片发生故障时，需要切换，这时候需要选举一个副本作为新主，这里除了会耗费一些时间外，也会有丢失数据的风险。

## Distributed Searching

现在从全局视角，来看一个分布式搜索是如何执行的。搜索不同于 CRUD 操作，在 CRUD 操作中，我们是知道具体集群中哪个 Shard 含有该文档。搜索则比较复杂，因为目标文档可能存在集群中任何 Shard 上面。

### Query

在 Query 阶段， 查询会广播到索引中每一个分片拷贝。 每个分片在本地执行搜索并构建一个匹配文档的 topk 队列。
![](https://tech-proxy.bytedance.net/tos/images/1614694387149_b82a505e0413c9985a81f92e05622eaa)

1.  客户端发送一个 search 请求到随机一个节点，这里是 Node3，Node3 会创建一个大小为 K 的优先队列（K 为请求的分页参数 from 和 size 决定）
1.  Node3 将请求转发到索引的每个分片中（primary 或者 replica 都有可能）。每个分片在本地执行搜索请求，将结果排序并放到大小 K 的优先队列中。
1.  每个分片返回各自优先队列中的文档 ID 以及排序 Score 给协调节点，即 Node3，Node3 对所有结果进行合并、排序，得到一个全局排序后的文档 ID 列表。

### Fetch

查询阶段标识哪些文档 ID 满足搜索请求，Fetch 阶段则用来取回这些文档。
![](https://tech-proxy.bytedance.net/tos/images/1614694387155_a7342b7ecc5ae3c96661b829e20a2822)

1.  协调节点即 Node3，根据 Query 得到的文档 ID 列表，向相关分片提交多个 GET 请求。
1.  每个分片加载文档返回给 Node3
1.  等待所有文档取回，将结果合并返回给客户端

# Data in

通过使用 index API ，文档可以被索引（indexing） —— 存储和使文档可被搜索。 但是首先，我们要确定文档的位置。一个文档的唯一标示，由 _index 、 _type 和 _id 决定。 我们可以提供自定义的 _id 值，或者让 index API 自动生成。
下面简单看下 ES 提供的 CRUD 接口。

## Write

我们可以提供自定义的 _id 值，或者让 index API 自动生成。

```
PUT /{index}/{type}/{id}
{
  "field": "value",
  ...
}
```

-   客户端发送请求给随机一个 Node，这个 Node 就是 coordinating node （协调节点）。
-   coordinating node 对 document 进行**路由**，将请求转发给对应的 Node（有 primary shard）。
-   实际的 node 上的 primary shard 处理请求，然后将数据同步到 replica node 。
-   coordinating node 如果发现 primary node 和所有 replica node 都写入完成之后，就返回响应结果给客户端。

## Read

为了从 Elasticsearch 中检索出文档，我们仍然使用相同的 _index , _type , 和 _id ，但是 HTTP 方法更改为 GET :

```
GET /{index}/{type}/{id}?pretty
```

响应体包括目前已经熟悉了的元数据元素，再加上 _source 字段，这个字段包含我们索引数据时发送给 Elasticsearch 的原始 JSON 文档：

```
{
  "_index" :   "website",
  "_type" :    "blog",
  "_id" :      "123",
  "_version" : 1,
  "found" :    true,
  "_source" :  {
      "field": "value",
      ...
  }
}
```

-   客户端发送请求到**任意**一个 Node，称为 coordinate node 。
-   coordinate node 对 doc id 进行哈希路由，将请求转发到对应的 Node，此时会使用 round-robin **随机轮询算法**，在 primary shard 以及其所有 replica 中随机选择一个，让读请求负载均衡。
-   接收请求的 Node 返回 document 给 coordinate node 。
-   coordinate node 返回 document 给客户端。

***

当然，ES 还提供 update、delete 接口用来更新、删除文档，形式与上述相同在此不再赘述。另外，还有用于批量查询、批量操作的 mget、bulk 接口，感兴趣可以查阅官方权威指南。
需要注意的是，update 操作其实相当于创建一个新文档、删除旧文档的过程。此外，ES 通过使用多版本控制算法来进行并发写冲突解决。

# Information out

Elasticsearch 除了可以提供文档及其元数据存储之外，其最强大的莫过于基于 Lucene 而提供的搜索能力。

## Search

一个搜索请求可以包含一个或多个 query 来指定搜索参数。匹配结果则返回在 response 中的 hits 中。
下面例子列举了一个简单的搜索请求，即查询 user.id 为 kimchy 的所有文档（假设该字段为 keyword，即精确匹配。字段类型，即 mapping 可以参考 Indexing 章节）

```
GET /my-index-000001/_search
{
  "query": {
    "match": {
      "user.id": "kimchy"
    }
  }
}
```

默认返回匹配搜索结果的 top10 文档，上面例子只返回一条：

```
{
  "took": 5,
  "timed_out": false,
  "_shards": {
    "total": 1,
    "successful": 1,
    "skipped": 0,
    "failed": 0
  },
  "hits": {
    "total": {
      "value": 1,
      "relation": "eq"
    },
    "max_score": 1.3862942,
    "hits": [
      {
        "_index": "my-index-000001",
        "_type": "_doc",
        "_id": "kxWFcnMByiguvud1Z8vC",
        "_score": 1.3862942,
        "_source": {
          "@timestamp": "2099-11-15T14:12:12",
          "http": {
            "request": {
              "method": "get"
            },
            "response": {
              "bytes": 1070000,
              "status_code": 200
            },
            "version": "1.1"
          },
          "message": "GET /search HTTP/1.1 200 1070000",
          "source": {
            "ip": "127.0.0.1"
          },
          "user": {
            "id": "kimchy"
          }
        }
      }
    ]
  }
}
```

此外，ES 搜索请求还支持很多选项，例如

-   Query DSL：ES 提供一种基于 JSON 的请求体，并提供一些内置的请求类型，可以供用户自由进行组合。
-   聚合：可以使用 aggregation 即聚合操作，对搜索结果进行统计分析
-   多重搜索：可以使用使用正则式或者逗号分隔符搜索多个索引，例如 GET /my-index-000001,my-index-000002/_search
-   分页：默认 ES 只返回前 10 条匹配结果，但是 ES 也提供了由 from+size 组合的分页参数
-   获取指定字段：默认搜索结果返回整个文档，ES 也支持获取文档字段的子集
-   排序：默认搜索结果按照相关度进行排序，ES 也支持[script_score](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-script-score-query.html) 定制化分数计算。
-   异步搜索：某些搜索请求可能需要跨多个分片进行，并且分片数据很大，这时候搜素可能要花费较长时间。ES 提供异步接口，可以提交搜索请求、查询搜索状态、获取搜索结果。

## Analyze

分析（analyze）其实就是基于聚合（aggregation）能力进行各种统计分析，得到一些统计报表。aggregation 可以帮你回答类似下面的问题：

-   在大海里有多少针？
-   针的平均长度是多少？
-   按照针的制造商来划分，针的长度中位值是多少？
-   每月加入到海中的针有多少？

总的来说，Elasticsearch（7.11 版本）提供三种类型的聚合功能。

### Metric Aggregation

统计指标，类似字段的和、均值、方差等等，可以从文档中提取某字段通过内置聚合函数进行聚合，或者通过脚本进行求值。
ES 提供非常丰富的聚合函数，下面举几个例子：

-   Geo-bounds：返回给定字段的边界点坐标，即 top_left、bottom_right
-   Stats：返回给定字段的 min, max, sum, count 和 avg 信息
-   Cardinality：给定字段和计算精度，返回给定字段的近似基数

### Bucket Aggregation

将文档进行聚合，类似关系型数据库的 groupby，当然 bucket 也可以支持嵌套，例如 province bucket 下面嵌套 city bucket。
ES 提供非常丰富的聚合函数，下面举几个例子：

-   Sampler：一种过滤器，只返回相关性高的文档，去掉长尾的低质文档
-   Date range：提供人性化的时间区间（相对、绝对），根据时间进行聚合
-   Geo-Distance：给定点，在二维坐标点中根据距离区间进行聚合

### Pipeline Aggregation

将其他 aggregation 结果进行聚合，而不是简单对匹配文档进行聚合计算。例如，你想聚合统计全国每个省份的 GDP，得到一个 province_gdp 的 bucket；你可以通过 pipeline aggregation 对 province_gdp 进一步进行聚合，例如取得 max 的省份的 GDP。
ES 提供非常丰富的聚合函数，总的来说与 Metric Aggregation 类似，具体可以参阅 [官方文档](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-aggregations-pipeline.html)。

# Indexing

## Mapping

为了能够将时间域视为时间，数字域视为数字，字符串域视为全文或精确值字符串， Elasticsearch 需要知道每个域中数据的类型。这个信息包含在映射（mapping）中。
当你索引一个包含新域的文档的时候，Elasticsearch 会使用 [动态映射](https://www.elastic.co/guide/cn/elasticsearch/guide/2.x/dynamic-mapping.html) ，通过JSON中基本数据类型，尝试猜测域类型。
这意味着如果你通过引号( "123" )索引一个数字，它会被映射为 string 类型，而不是 long 。但是，如果这个域已经映射为 long ，那么 Elasticsearch 会尝试将这个字符串转化为 long ，如果无法转化，则抛出一个异常。
尽管在很多情况下基本数据类型已经够用，但你经常需要为某些域自定义映射，特别是字符串域。

-   域最重要的属性是 type 。对于不是 string 的域，一般只需要设置 type 。

```
{
    "number_of_clicks": {
        "type": "integer"
    }
}
```

-   string 类型域则默认包含全文。就是说，它们的值在创建索引前，会通过一个分析器，针对于这个域的查询在搜索前也会经过一个分析器。string 域映射的两个最重要属性是 index 和 analyzer 。

    -   index：控制如何索引字符串，string 类型默认是 analized

        -   analyzed：首先分析字符串，然后构建全文索引
        -   not_analyzed：索引这个域，但索引的是精确值
        -   no：不索引这个域，即无法被搜索

        ```
        {
            "tag": {
                "type":     "string",
                "index":    "not_analyzed"
            }
        }
        ```

	-   analyzer：对于 analyzed 字符串域，用 analyzer 属性指定在搜索和索引时使用的分析器

        ```
        {
            "tweet": {
                "type":     "string",
                "analyzer": "english"
            }
        }
        ```

***

当你首次创建一个索引的时候，可以指定类型的映射。你也可以使用 /_mapping 为新类型增加映射，但是不能修改现有的映射，例如将一个存在的域从 analyzed 改为 not_analyzed。

## Index Structure

> 索引创建：就是从语料库中提取信息，创建索引的过程。

> 搜索索引：就是得到用户的查询请求，搜索创建的索引，然后返回结果的过程。

ES 基于 Lucene，而 Lucene 的索引结构为倒排索引，大致如图所示
![](https://tech-proxy.bytedance.net/tos/images/1614694387216_ac8a56b9db9758cf5f1eebdd3ff69ccc)
我们通常习惯使用正排索引，即形如 user_id => user_info 的映射；而倒排索引则反过来，通过形如 user_info.name => user_ids，或者 user_info.age => user_ids 得到一个逆映射，并且映射的 ID 值通常是一个列表。

### Posting List

Posting List 其实就是文档 ID 列表，例如上述例子的 user_ids。

### Term Dictionary

Term 指的是文档中的字段值。例如，name 字段可以有很多个 Term，比如：Carla，Sara，Elin，Ada，Patty，Kate，Selena。如果没有排序，那么找出某个特定的 Term 会很慢，因为 Term 没有排序，需要全部遍历一遍才能找到特定的 Term，排序之后就变成了：Ada，Carla，Elin，Kate，Patty，Sara，Selena，这样就可以用二分搜索，快速找到目标的 Term。
而如何组织这些 Term的方式就是 Term Dictionary，除了存储 Term 的值之外，还存储 Term 的统计值例如词频。有了 Term Dictionary 之后，就可以用比较少的比较次数和磁盘读次数查找目标。

### Term Index

通常 Index 的量级非常大，因此 Term Dictionary 也非常大，无法直接 load 到内存中，因此需要一种保存在内存中的压缩的数据结构来加速读取。Term Index 其实就是一种前缀树（也是一种有限状态机，FST），通过 Term Index 可以快速定位到目标 Term 在 Dictionary 文件中的 offset。
因此通过这么一条链路：Term Index => Term Dictionary => Posting List，通过 Posting List 里的文档 ID 查询，得到我们的结果文档，并根据相关度进行排序。

# Application

ElaticSearch 可以有非常丰富的应用场景，笔者没办法进行全面列举，只选择了主要的三个：

-   数据存储：建立 searchable 的文档数据、目录数据、日志数据系统
-   作为数据库的补充：例如利用 CDC 功能，对数据库内容添加 ES 索引，可以进行可视化等分析操作；甚至与 Hadoop 进行交互，对 Hadoop 数据提供快速的搜索、分析、可视化能力
-   数据分析：对存储的数据进行统计、分析、可视化

# Conclusions

Elasticsearch 是一个分布式的，RESTful 的分析引擎及搜索引擎。很多公司都转型使用 ES 融入其后端基础架构，因为 ES 提供很多能力：

-   对海量数据进行聚合分析，得到一个数据的宏观模型
-   支持多样化的搜索及分析能力：精确匹配、模糊匹配、地理坐标搜索、统计分析
-   实时的处理能力
-   提供多种语言的客户端或 SDK，例如 SQL、Python、Java
-   ELK Stack 提供方便的数据收集、可视化功能

# References

-   [Elasticsearch: 权威指南](https://www.elastic.co/guide/cn/elasticsearch/guide/2.x/index.html)
-   [Elasticsearch: Reference](https://www.elastic.co/guide/en/elasticsearch/reference/current/index.html)
