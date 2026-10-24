# dsh-event-chime（事件提示音）

给 DSH 的事件配提示音。**每类事件一个音频池**，池里有音频就洗牌轮换着播；池是空的就播内置的 Web Audio 合成音——所以还没录任何音频时，事件层就能先跑起来验证。

## 事件

事件来自客户端服务 `ctx.uiSession.sessionStatus`，它把三个事实合并成一张快照：

```
Map<sessionId, { running, pendingInteraction, completionUnread }>
```

| 事件 | 判据 |
| --- | --- |
| 回合完成 | `running` true → false，且是主视图会话 |
| 后台会话完成 | `completionUnread` false → true（只对非主视图会话置位） |
| 需要授权 | `pendingInteraction.kind === 'approval'` |
| 需要回答 | `pendingInteraction.kind === 'question'` |
| 计划评审 | `pendingInteraction.kind === 'plan-review'` |
| 卡住 | `running` 持续超过阈值（默认关闭） |

`kind` 只有这三个值：approval 域写死 `"approval"`；user-questions 域是
`planReviewOf(questions) === undefined ? "question" : "plan-review"`。

**待接入**：「任务失败」需要从会话快照里读终态，这一版没接。设置面板底部的「最近事件」日志就是为它准备的——先确认事件触发时机对不对，再决定从哪个字段取失败信号。

## 音频池

- 音频有两个来源：**随插件分发的内置包**（`audio/<事件>/*`，由 Host 的只读路由提供）和**本机导入**（存在浏览器 IndexedDB，不进仓库）
- 面板顶部可以关掉「混入内置音频包」，只用自己导入的
- 轮换模式：洗牌轮换（默认，一轮内不重复且不和上一条重复）/ 纯随机 / 顺序
- 设置面板：每类事件一行——开关、试听、导入（可多选）、清空；池内条目点一下试听，本机条目可以 × 删掉
- 免打扰时段、音量、卡住阈值都在同一页

### 内置音频包

仓库里的 `audio/` 目录会随插件一起分发，布局就是事件名：

```
audio/
  completed/01.wav
  approval/01.wav
  question/01.wav
  plan-review/01.wav
  stalled/01.wav
```

Host 侧（`index.js`）把整个目录挂成只读路由：

- `GET /dsh-event-chime/audio.json` —— 扫描各事件目录，返回这个包实际带了哪些文件
- `GET /dsh-event-chime/audio/<事件>/<文件>` —— 音频字节，带缓存头

加音频只需要往目录里放文件，不用改代码：`audio.json` 是每次请求实时扫描出来的。支持的扩展名：`.wav` `.mp3` `.ogg` `.opus` `.m4a`。没放任何音频时它返回空表，客户端自动退回合成音。

### 把本机导入的音频导出成仓库结构

设置面板底部有「导出全部音频（zip）」，导出内容就是 `audio/<事件>/<文件名>`，解压到仓库根目录即可。

### 怎么录音频

音频可以自己录，来源不限。想用 DeepSeek 官网那个音色（贝壳 / 白浪 / 海星 / 暗潮）：

1. 在 `chat.deepseek.com` 里发一句「只输出这四个字，不要标点、不要解释：任务完成」
2. 等它回，点回答下面的朗读小喇叭
3. 用 [DeepSeek 朗读下载器](https://github.com/zhou914485/deepseek-tts-downloader) 把这条朗读存成 WAV——它支持连抽几版再挑最好的那条
4. 回到这里的设置面板，导入到对应事件
5. 想把这批音频随插件分发，点面板底部的「导出全部音频（zip）」，解压到仓库根目录

一个短语一轮对话 + 一次朗读额度。想要变化感，就同一事件多录几条（换音色、换说法），丢进同一个池。

## 安装

```bash
git clone https://github.com/zhou914485/dsh-event-chime.git
```

装进 DSH 有两种方式：

- **推荐**：让 DSH 的 `plugin_manager` 执行 `install_bundle`，target 指向这个插件目录。
- **手动**：改 profile 的 `package.json`（Windows 下是 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`）：

  1. `dependencies` 加一行 `"@local/dsh-event-chime": "link:<插件目录绝对路径>"`
  2. `dsh.profile.bundles` 数组加 `"@local/dsh-event-chime"`
  3. 在 profile 的 `node_modules/@local/` 下建一个指向插件目录的链接（junction / symlink）

改完**重启 DSH** 生效。重启后到 设置 页面找「事件提示音」那一栏。

## 卸载

删掉 profile `package.json` 里的 dependency 和 bundles 条目、删掉 `node_modules/@local/dsh-event-chime` 链接，重启即可。本机导入的音频存在浏览器的 IndexedDB 里，清站点数据就没了。

## 隐私

不外发任何数据。音频要么随插件在本地，要么只在你本机的浏览器存储里。
