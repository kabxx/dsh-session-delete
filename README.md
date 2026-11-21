# @kabxx/dsh-session-delete

面向 DeepSeek Harness（`0.2.2-rc.5`）的会话永久删除插件，支持 Linux（含 WSL）、macOS 与原生 Windows 的默认 JSONL 存储。

- 在会话右键菜单（「归档会话」下方）增加危险态的「删除会话」入口，确认框展示会话标题及将一并移除的子智能体会话数量。
- 采用两阶段事务提交：先整组暂存移出主会话与关联子会话目录，提交后再递归删除并同步清理工作区关联、置顶、归档、投影缓存与 SQLite 全文搜索索引；中途中断时自动回滚恢复。
- 自动释放空闲的 Web 会话句柄并等待刚结束的子智能体写入句柄收尾，通过原生会话锁（Linux / macOS `flock`、Windows 命名信号量）校验独占状态；运行中会话或仍有未迁移分叉依赖时拒绝删除。

## 安装

需要 Node.js `>= 24.9.0`（Linux 环境需包含 `/usr/bin/flock`）：

```bash
dsh plugin --profile web add @kabxx/dsh-session-delete
```

也可在 DSH 插件管理器中选择「添加插件」并输入 `@kabxx/dsh-session-delete`（若使用其他配置档案，将 `--profile web` 替换为对应档案名）。本地调试源码时，直接填入克隆后的仓库目录绝对路径或执行 `dsh plugin --profile web add .` 即可。

## 开发

运行语法检查与测试（崩溃回滚及跨平台锁测试需将 `DSH_INSTALL_DIR` 指向本机 `@deepseek-ai/dsh` 安装目录）：

```bash
export DSH_INSTALL_DIR="$(npm root -g)/@deepseek-ai/dsh"
npm run check
npm test
npm pack --dry-run
```

## 项目结构

| 路径 | 内容 |
| --- | --- |
| [`src/index.js`](src/index.js) | Host 入口，注册 `/api/session-delete/session` 接口 |
| [`src/delete.js`](src/delete.js) | 删除预览、确认票据、两阶段事务恢复与关联索引清理 |
| [`src/delete-tree.js`](src/delete-tree.js) | 会话组锁校验、整组暂存移出、中断回滚与递归删除 |
| [`src/delete-disk.js`](src/delete-disk.js) | 原生 JSONL 租约下的文件指纹校验与旧版日志兼容清理 |
| [`src/disk-trash.js`](src/disk-trash.js) | 会话存储路径编码校验与离线目录暂存 |
| [`src/online-disk.js`](src/online-disk.js) | 在线会话目录树检查、来源校验与文件锁协调 |
| [`src/platform-fs.js`](src/platform-fs.js) | 跨平台会话锁（`flock` / Windows 信号量）与原子重命名封装 |
| [`src/idle-web-writer.js`](src/idle-web-writer.js) | 识别并释放空闲的 Web 及子智能体会话写入句柄 |
| [`src/stale-projection.js`](src/stale-projection.js) | 投影缓存未挂载时清理残留 JSON 快照 |
| [`src/stale-search.js`](src/stale-search.js) | 搜索服务停用时清理原生 SQLite 全文索引条目 |
| [`src/client.js`](src/client.js) | Web 客户端右键菜单项、危险态确认弹窗与 Toast 提示 |
| [`locale/`](locale/) | 插件管理页中英文标题与描述 |
| [`test/`](test/) | 跨平台锁竞争、两阶段崩溃恢复、投影与全文索引清理测试 |

插件入口与注入配置见 [package.json](package.json) 和 [cordis.patch.yml](cordis.patch.yml)。
