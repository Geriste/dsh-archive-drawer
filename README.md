# dsh-archive-drawer

给 [DeepSeek Harness](https://github.com/deepseek-ai) 做的归档插件。装完侧边栏会多一项「归档」，点开是所有已归档对话的清单，能恢复、能删、能看每条对话的上下文总结。

## 起因

DSH 自带归档功能，但归档过的对话在侧边栏里是藏起来的（视图默认档是「隐藏已归档」）。想翻一条，得先取消归档把它放回工作区，看完再归档回去。攒多了就懒得翻了。

所以写了这个：把归档的那批会话集中到一页里。顺手加了两件我更需要的事，归档那一刻自动生成一份上下文总结，删除的时候能把总结一起处理干净。

## 装法

profile 的 `package.json` 里加一行依赖、再把包名写进 bundles：

```json
"dependencies": { "dsh-archive-drawer": "link:../../plugins/dsh-archive-drawer" },
"dsh": { "profile": { "bundles": [ "...", "dsh-archive-drawer" ] } }
```

然后在 profile 目录（如 `~/.dsh/profiles/desktop`）跑一次 `pnpm install`。宿主半侧改完就热更新了，浏览器半侧是页面加载时注入的，要刷新窗口（Ctrl+R）。

## 能干什么

| 能力 | 说明 |
| --- | --- |
| 侧边栏入口 | `sidebar.panellist` 里多一行「归档」，点开是自己的中央面板（`main` 槽，key = `dsh-archive-drawer`） |
| 统一列表 | 所有已归档会话的标题、所属工作区、创建时间、总结状态，一屏看完 |
| 一键恢复 | 调官方 `ctx.workspaces.unarchiveSession()`，把会话放回原来那个工作区 |
| 归档时自动总结 | 发现新的归档就调宿主 `llm` 服务生成总结，写进专用文件夹 |
| 手动生成 | 每行都能单独生成或重做总结；顶部另有「全部生成总结」补历史存量 |
| 面板里直接看 | 总结的 Markdown 直接内联展开，不用去翻文件夹 |
| 多选批量 | 勾一批会话，一次批量生成总结 / 恢复 / 删总结文件 / 删对话 |
| 打开总结文件夹 | 调系统文件管理器打开对应目录 |
| 彻底删除 | 会话目录进回收站，可手动捞回 |

## 删除是怎么走的

删一个对话要动四个地方，少动一处都会留下半死不活的状态：

1. 会话目录整个 `rename` 到 `<DSH_HOME>/dsh-archive-drawer/trash/<时间>-<sessionId>/session/`，旁边写一份 `meta.json` 记下原路径、标题、删除时间
2. 从工作区摘掉（`workspace.detachSession()`），同时保证它还在全局归档集合里（`ensureArchived()`：已在里面就不动，不在就调官方 `workspaceRegistry.archiveSession()` 补上）。这一步绝不能反着做，见下面
3. 删掉侧边栏的投影缓存 `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`。不清它，侧边栏会留一条点不开的僵尸会话，点开报 `session not found`
4. 在账本 `state.json` 的 `deletedSessionIds` 里记一笔

面板里问几句要看你之前总结过没有：

| 情况 | 问什么 | 结果 |
| --- | --- | --- |
| 已经有总结 | 只确认一次「删到回收站？」 | 对话本体进回收站，总结文档留着 |
| 还没有总结 | 三选一：先生成总结再删 / 不总结直接删 / 取消 | 选了先总结但总结失败，整体中止，不删 |
| 会话正在跑 | 不问了 | 直接拒掉，提示先停掉 |

总结文件不会跟着对话一起删，它是个独立的动作。列在面板里的行，都是当前还真实存在的归档会话。

### 为什么删掉的对话不会在侧边栏阴魂不散

第一版我写错了，踩出来的。

侧边栏判断一行要不要渲染，用的是 app.asar 里的 `sessionVisible()`：

```js
if (session.origin === "subagent") return false
if (session.blank && session.id !== current) return false
switch (archivedFilter) {
  case "default": return !archived.has(session.id)   // 默认档「隐藏已归档」
  case "show":    return true                        // 「全部对话（显示已归档）」
  case "only":    return archived.has(session.id)    // 「仅显示已归档」
}
```

再用 `groupByWorkspace()` 分组：工作区成员从 `workspace.sessionIds` 取；不属于任何工作区、又算得上可见的，全部归进「未分组」。

第一版删完是 detach 加 unarchive，于是这个会话既不在任何工作区、也不在归档集合里，`sessionVisible()` 判它可见，被丢进「未分组」。而宿主进程里对这个会话还留着账（`sessionPersistence` 的可见性说的是：本进程创建过的会话，就算文件搬走了也仍然认得），所以侧边栏有东西可渲染。结果就是删掉的对话又冒出来，点开报 `session not found`，重启一次才好，因为重启后宿主按磁盘重建清单就不认得它了。

正确做法是把它留在归档集合里。归档集是全局的，默认档对归档行一律返回 false，那一行立刻不渲染。走官方 `archiveSession()` 还会让宿主往 `workspaceController.follow` 推一帧 `{type:'archived', archivedSessionIds}`，前端拿到新集合马上重算，不用重启。

配套还有两处：`buildState()` 拿 `state.deleted` 把这些带归档标记的已删会话从面板列表里再剔掉（否则它们会以归档身份回到这里）；启动时 `repairDeletedArchive()` 补老版本留下的残影，账本里已删但不在归档集合里的逐条补 `archiveSession()`，宿主完全不认得的（报 `live sessions and session persistence hold no such session`）跳过。

想捞回来，把 `trash/<时间>-<id>/session/` 整个搬回 `meta.json` 里写的 `sourceDir` 就行。

## 多选批量

每行左边有复选框，标题下有「全选」。选中之后出现一条批量操作栏：

| 按钮 | 干什么 |
| --- | --- |
| 批量生成总结 | 选中的一次排进队列，已有总结的自动跳过，按钮上会写跳过了几个 |
| 批量恢复 | 逐个 `unarchiveSession()`，放回各自原来的工作区 |
| 批量删总结（N） | 只删总结文件，N 是选中的里面有总结的份数，对话本体一个不动 |
| 批量删除对话 | 选中的对话本体全部进回收站，确认框会告诉你几个还没总结，并给「先补齐总结，再删」 |
| 取消选择 | 清空勾选 |

批量删除是逐条独立的：某一条失败（比如正在生成总结）只跳过它，其余照样删，完事统一报「已删 N 个，M 个失败」。批量走的是同一组 HTTP 接口，只是把 `sessionId` 换成 `sessionIds: [...]`。

## 文件都放哪

```
<DSH_HOME>/dsh-archive-drawer/
├── summaries/
│   └── <sessionId>__<标题>.md
├── trash/
│   └── <时间>-<sessionId>/
│       ├── session/            # 整个会话目录原封不动
│       └── meta.json
└── state.json                  # 插件账本：见过的归档集合 + 删过的会话
```

总结文档的结构：

```markdown
# <会话标题>

> 会话 ID / 工作区 / 创建时间 / 归档总结时间 + 用的模型

## 一句话概述
## 做了什么
## 关键结论与决策
## 产出物与文件
## 未完成 / 后续

---
<details>
<summary>对话原文节选（已截断）</summary>
...
</details>
```

## 什么时候会自动总结

- 新归档的，立刻生成。每 20 秒兜底轮询一次，官方 `domain/changed` 事件也会即时触发
- 关机期间归档的，下次启动补上
- 装插件之前就已经归档的不会自动生成，不然一装插件就烧掉十几个模型调用。用面板顶部的「全部生成总结」一次补齐

## 用哪个模型

取宿主当前默认模型（`agentDefaultModel.currentSelection()`），也就是你在设置里选的那个；拿不到就退到 `qwen-token-plan-cn / deepseek-v4-flash`。

## 代码结构

```
dsh-archive-drawer/
├── package.json          # dsh.bundle.patch / dsh.client.platform = web
├── cordis.patch.yml      # 把自己插进 profile 的条目列表
└── lib/
    ├── index.js          # 宿主半侧：读归档真相 + 调 llm 写文档 + HTTP 路由
    └── client.js         # 浏览器半侧：侧边栏入口 + 面板（手写 bundle，不用构建）
```

浏览器半侧是手写的 `__ModuleLoader__` bundle，没有构建步骤：改完 `lib/client.js` 刷新页面就生效。注意 factory 里要自己声明 `var module = { exports: {} }`，加载器只传 `require` 进来，少这一行会 `ReferenceError`，而 web boot 是一个 client entry 挂了就整体不激活。

## HTTP 接口

都是同源路由，网页端只走这些：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-archive-drawer/api/state` | 归档列表 + 总结状态 + 目录路径 + 回收站数量 |
| POST | `/dsh-archive-drawer/api/summarize` | `{sessionId, force}` 生成一个；`{all:true}` 全部；`{sessionIds:[...], force}` 批量 |
| GET | `/dsh-archive-drawer/api/doc?sessionId=` | 取总结 Markdown 原文 |
| POST | `/dsh-archive-drawer/api/delete-doc` | `{sessionId}` 或 `{sessionIds:[...]}`，只删总结文件 |
| POST | `/dsh-archive-drawer/api/delete` | `{sessionId, summarizeFirst?}` 或 `{sessionIds:[...], summarizeFirst?}`，彻底删除 |
| POST | `/dsh-archive-drawer/api/reveal` | `{target: 'root' \| 'summaries' \| 'trash'}` 打开对应目录 |

批量接口统一返回 `{ ok, results:[{sessionId, ok, ...}], done, failed }`。

## 出问题先看这里

- 侧边栏没有「归档」：客户端 bundle 是页面加载时注入的，刷新一下窗口
- 接口 404：宿主半侧没挂上。看「插件」页里 `dsh-archive-drawer` 的 fiber 是不是 active，不是就重新启用一次
- 总结一直「生成失败」：面板里会显示宿主日志（模型报错、缺服务之类）。模型不可用就去设置里换一个默认模型