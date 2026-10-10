# koishi-plugin-teamspeak-music-bot

适用于 Koishi 的 TeamSpeak Music Bot 对接插件。

直接调用 TeamSpeak Music Bot 原生提供的 Web REST API，无需修改原项目任何代码，即可在 QQ、Discord、Telegram、KOOK 等连接到 Koishi 的聊天平台中点歌、切歌、遥控 TeamSpeak 频道的音乐机器人。

---

## 功能特性

- 零修改原项目: 纯粹基于原项目官方现成的 /api/player 与 /api/music REST 接口，即插即用。
- 动态多机器人切换: 输入「切换机器人」，自动列出服务端全部机器人的名称、在线状态与频道；直接发送数字编号即可切换绑定当前控制的机器人，亦支持「切换机器人 1」一步切换。
- 点歌与播放: 支持通过歌名、歌手点歌（对应 !play）。
- 智能下一首插播: 输入「下一首播放 <歌曲>」，自动检索目标曲目并插播到下一首优先播放（对应 !playnext）。
- 交互式搜索: 支持在聊天中输入「搜索 <关键词>」，列出编号结果；随后直接输入「播放 1」或「下一首播放 1」快捷操作（对应 !search）。
- 多音源切换: 支持参数指定音源平台（-n 网易云、-q QQ 音乐、-b 哔哩哔哩、-k 酷狗音乐、-y YouTube）。
- 完整播放控制: 切歌、上一首、暂停、继续、停止、查看正在播放、查看播放列表、清空列表、音量调节、播放模式切换。

---

## 安装与使用

### 1. 从 Koishi 插件市场安装（发布后推荐）
插件发布至 npm 后，将由 Koishi 官方市场自动索引:
- Web 控制台: 进入 Koishi 控制台的「插件市场」，搜索 teamspeak-music-bot，点击安装并启用。
- 命令行安装: 在您的 Koishi 实例目录下执行:
  ```bash
  npm install koishi-plugin-teamspeak-music-bot
  # 或
  yarn add koishi-plugin-teamspeak-music-bot
  ```

### 2. 本地调试与开发接入（未发布时）
若要在本地 Koishi 开发环境中调试本插件，请遵循 Koishi 开发规范:
- 方式 A（全局软链接，推荐）:
  1. 在本插件目录 d:\Code\teamspeak-music-bot\koishi 下执行:
     ```bash
     npm install
     npm run build
     npm link
     ```
  2. 在您的 Koishi 运行实例目录下执行:
     ```bash
     npm link koishi-plugin-teamspeak-music-bot
     ```
  3. 重启 Koishi 或在控制台启用即可。
- 方式 B（Koishi 模板工作区）:
  若您使用的是通过 create-koishi 创建的标准开发工作区（monorepo），可将本目录放置在工作区的 external/teamspeak-music-bot 目录下，工作区会自动将其作为本地插件识别并加载。

---

## 插件发布流程（面向开发者）

由于本插件已经配置完整的 prepublishOnly 构建钩子和符合规范的 package.json，发布流程如下:

1. 进入插件目录并安装依赖:
   ```bash
   cd koishi
   npm install
   ```

2. 更新版本号（如需升级）:
   ```bash
   npm version patch  # 1.0.0 -> 1.0.1
   # 或
   npm version minor  # 1.0.0 -> 1.1.0
   ```

3. 发布到 npm 仓库:
   ```bash
   npm login          # 登录您的 npm 账号（若未登录）
   npm publish --access public
   ```
   构建脚本会在发布前自动执行 tsc 构建，将最新的 lib/ 产物打包上传。

4. 进入 Koishi 插件市场:
   发布成功后，Koishi 官方镜像（registry.koishi.chat）会在数分钟至数十分钟内自动检测并收录该插件，届时所有 Koishi 用户均可在插件市场直接搜索并安装。

---

## 插件配置项 (Config)

在 Koishi 控制台插件管理页面进行可视化配置:

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| endpoint | string | http://127.0.0.1:3000 | TeamSpeak Music Bot 的 WebUI 地址 |
| apiKey | string | "" | 服务端 API Key。在 Web 后端 设置 -> API 密钥 中生成（开启游客模式时可留空） |
| botId | string | "" | 默认目标机器人实例 ID（留空则自动选择首个在线机器人，也可随时在聊天中通过「切换机器人」动态绑定） |
| defaultPlatform | string | "default" | 默认音源平台（可选网易云/QQ/B站/酷狗/YouTube） |
| enableChineseAliases | boolean | true | 是否启用自然中文别名（如“播放”、“切歌”等） |

---

## 指令一览表

| Koishi 输入指令 | 别名 | 调用的官方 REST API | 说明 |
| :--- | :--- | :--- | :--- |
| 切换机器人 | 选择机器人、tsmb.switch | GET /api/bot | 列出机器人列表，回复数字序号即可切换当前控制的机器人；亦可直接输入「切换机器人 1」 |
| 播放 <歌名> | 点歌、tsmb.play | POST /api/player/:botId/play | 点歌播放（支持指定 -q 等音源，或填搜索序号） |
| 下一首播放 <歌名> | 插播、tsmb.playnext | GET /search + POST /play-next-song | 自动搜索曲目并插播到下一首优先播放 |
| 搜索 <关键词> | tsmb.search | GET /api/music/search | 搜索歌曲列表并缓存序号结果 |
| 加歌 <歌名> | tsmb.add | POST /api/player/:botId/add | 仅将歌曲加入播放列表末尾 |
| 暂停 | tsmb.pause | POST /api/player/:botId/pause | 暂停播放 |
| 继续 | 恢复、tsmb.resume | POST /api/player/:botId/resume | 恢复播放 |
| 切歌 | 下一首、跳过、tsmb.next | POST /api/player/:botId/next | 跳过当前歌曲播放下一首 |
| 上一首 | tsmb.prev | POST /api/player/:botId/prev | 播放上一首 |
| 停止 | tsmb.stop | POST /api/player/:botId/stop | 停止播放 |
| 清空列表 | 清空、tsmb.clear | POST /api/player/:botId/clear | 清空等待播放的队列 |
| 正在播放 | 当前播放、tsmb.now | GET /api/player/:botId/queue + elapsed | 查看当前曲目、歌手、音源及播放进度 |
| 播放列表 | 队列、歌单、tsmb.queue | GET /api/player/:botId/queue | 查看待播歌曲清单 |
| 音量 [0-100] | tsmb.vol | POST /api/player/:botId/volume | 查看或设置播放音量 |
| 播放模式 [模式] | tsmb.mode | POST /api/player/:botId/mode | 切换模式（sequence / repeat / random） |
| tsmb状态 | tsmb.status | GET /api/bot | 查看所有 TS 音乐机器人在线状态与频道 |

---

## 常用场景示例

### 1. 切换机器人
- 两步对话切换:
  1. 用户发送: 切换机器人
  2. 机器人回复:
     ```text
     请输入数字序号选择要切换的机器人:
     1. [测试机器人] - [在线] <- [当前控制] (频道: 音乐厅)
     2. [二号开黑机] - [在线] (频道: 游戏大厅)
     
     提示: 请直接发送数字序号（如 1）完成切换，输入其他内容或 30 秒无操作将自动取消。
     ```
  3. 用户发送: 2
  4. 机器人回复: [成功] 切换完成！当前控制机器人: [二号开黑机] (频道: 游戏大厅)
  5. 之后该用户在群内的所有播放操作将直接控制二号机。
- 一步快捷切换:
  - 用户直接发送: 切换机器人 2

### 2. 搜索并点歌
- 用户输入: 搜索 周杰伦
- 机器人回复:
  ```text
  搜索结果 [网易云]:
  1. 晴天 - 周杰伦 [叶惠美] (04:29)
  2. 告白气球 - 周杰伦 [周杰伦的床边故事] (03:35)
  3. 稻香 - 周杰伦 [魔杰座] (03:43)
  ...
  提示: 直接发送「播放 1」点歌，或发送「下一首播放 1」插播。
  ```
- 用户输入: 播放 1（自动点播晴天）
- 用户输入: 下一首播放 2（自动插播告白气球）

---

## 许可
MIT License.
