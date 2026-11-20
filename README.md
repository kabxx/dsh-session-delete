# @kabxx/dsh-session-delete

面向 DeepSeek Harness Web（`0.2.2-rc.5`）的会话永久删除插件（支持 Linux 与 WSL 默认 JSONL 存储）。

- 在会话右键菜单（`归档会话` 下方）增加红色的「删除会话」入口，确认框展示会话标题及将一并移除的子智能体会话数量。
- 确认后递归删除对应 JSONL 会话目录，并同步清理工作区关联、置顶、归档、投影缓存与 SQLite 全文搜索索引记录。
- 自动释放空闲的 Web 会话句柄并通过 `flock` 文件锁校验状态；运行中会话或仍有未迁移分叉依赖时拒绝删除。

## 安装

需要运行在 Linux 或 WSL 环境（Node.js `>= 24.9.0`，系统包含 `/usr/bin/flock`）：

```bash
dsh plugin --profile web add @kabxx/dsh-session-delete
```

也可在 DSH 插件管理器中选择「添加插件」并输入 `@kabxx/dsh-session-delete`。本地调试源码时，直接填入克隆后的仓库目录绝对路径或执行 `dsh plugin --profile web add .` 即可。

## 开发

本包无外部依赖、无构建步骤，直接基于 Node.js 原生 ESM 运行：

```bash
npm run check
npm test
npm pack --dry-run
```

## 项目结构

| 路径 | 内容 |
| --- | --- |
| [`src/index.js`](src/index.js) | Host 入口，注册 `/api/session-delete/session` 接口 |
| [`src/delete.js`](src/delete.js) | 删除预览、确认票据、中断恢复与原生索引/工作区记录清理 |
| [`src/delete-tree.js`](src/delete-tree.js) | 会话目录锁校验、暂存移出与递归删除 |
| [`src/idle-web-writer.js`](src/idle-web-writer.js) | 识别并释放空闲的 Web 会话写入句柄 |
| [`src/online-disk.js`](src/online-disk.js) | JSONL 路径安全校验与内核 `flock` 锁封装 |
| [`src/stale-projection.js`](src/stale-projection.js) | 投影缓存未挂载时清理残留 JSON 快照 |
| [`src/stale-search.js`](src/stale-search.js) | 搜索服务停用时清理原生 SQLite 全文索引条目 |
| [`src/client.js`](src/client.js) | Web 客户端右键菜单项、确认弹窗与 Toast 提示 |
| [`locale/`](locale/) | 插件管理页中英文标题与描述 |
| [`test/`](test/) | 锁竞争、崩溃恢复、投影与全文索引清理集成测试 |

插件入口与注入配置见 [package.json](package.json) 和 [cordis.patch.yml](cordis.patch.yml)。
