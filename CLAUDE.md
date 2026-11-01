# CLAUDE.md

收件箱：以虎 One 官方应用，个人一句话记待办、团队派单、批量整理、导入、周报。Express 4 + EJS + 平台 SDK，MySQL 用 `mysql2/promise`，没有前端构建步骤。平台约定以 `../yihu-one/CLAUDE.md` 和开发中心 `console/docs/devcenter/` 为准，结构照 `../yihu-meeting`（参考实现）。

## 结构

```
src/
  server.js        入口：先监听再连库，/health 如实反映启动状态
  app.js           只做接线：中间件 → 导入 → 接口 → MCP → 页面
  db.js            建表 + ADDED_COLUMNS（新增列登记在这里，要可空或有默认值）
  tasks.js         任务的全部读写，含批量、撤销、周报查询。权限只在这一层，每条 SQL 带当前用户 id
  import.js        文字 / 文件 → 预览行，只解析不写库
  report.js        周报口径和 Markdown，页面、复制、周五推送共用
  digest.js        定时推送：每分钟醒一次，库里占位防重发
  settings.js      每人一份的设置，每次现读，改完即生效
  about.js         关于页信息、平台模型名
  present.js       库里的行 → 页面要的样子；dates.js 时间只在这里算
  routes/          api.js、import.js、pages.js、list.js，保持薄
  views/           layout/head、foot 每页都有；顶栏在 head 里
  public/yh-vi.css 令牌段（同步）+ 组件段（手写），三个应用共用，和会议逐字节一致
  public/app.css   本应用的排布和业务块
  public/          app.js 公用，home.js 列表，batch.js 多选和键盘，import.js、settings.js 各一页
scripts/sync-vi.mjs  从平台同步令牌
e2e/run.mjs          回归走查；e2e/gates.mjs 发版门槛和截图
```

## 测试怎么跑

```bash
npm test                               # 真实 MySQL。没给 TEST_DATABASE_URL 就用 Docker 起临时库
E2E=1 npm test                         # 单测过了接着在同一个临时库上跑 e2e/run.mjs 和 e2e/gates.mjs
TEST_DATABASE_URL=mysql://… npm test   # 用现成的库，表会被清空，不要指向有数据的库
../yihu-one/yh check . --strict
node scripts/sync-vi.mjs --check       # 令牌和平台是否一致
```

假平台在 `test/support/fake-platform.mjs`，走真实 SDK 的登录流程，应用代码里没有测试后门。`test/dedupe.test.js` 是去重的回归基线，不许为了新功能放宽。

## 约定

**界面**
- 颜色、圆角、字体只用 `var(--yh-*)`。`yh-vi.css` 令牌段以外不准出现十六进制色、渐变、投影，`test/vi.test.js` 会拦
- CSS 不用 id 选择器：`#add…` 这种会被十六进制检查误伤
- 强调色 `--yh-highlight` 全应用只用一处（今日进度条）。圆角只有 `--yh-radius`、`--yh-radius-sm` 和胶囊 999px
- 可点元素一律 ≥44px，桌面也一样；375 宽不横向滚动
- CSP 不允许内联样式：进度条用 `<progress>`，不写 `style=`
- 本应用的东西写 `app.css`，`yh-vi.css` 组件段不要改，要和会议一致

**数据**
- 权限只在 `tasks.js`：看得到的是自己创建的和指派给自己的，其余 404；被指派人只能完成 / 重开，改别的 403
- 日期只在 `src/dates.js` 里算，「今天」和「本周」按 `INBOX_TZ`（默认 Asia/Shanghai），不用数据库的 `CURDATE()`
- 时间列存 UTC；按天、按周查时用 `startOfDayUtc`、`weekRange` 换算
- 回滚只回代码不回库，新列要可空或有默认值
- 归档是软删除（`archived_at`）。新写的查询都要带 `ALIVE`，否则归档的事会回到统计和推送里
- `tags` 目前只放「负责人待确认：某某」，指派给人时清空
- `source='app'` 是导入的，事件 detail 里 `via: 'import'`

**批量**
- 一个请求一个事务：`SELECT … FOR UPDATE` 按 id 顺序锁，能做的一条 UPDATE 改完。权限不符跳过并报数，数据库出错整批回滚
- 撤销快照存 `inbox_batch`。页面窗口 3 秒，服务端多留 2 秒给网络；只还原值还等于批量结果的行，连 `updated_at` 一起还原
- 批量指派的通知等撤销窗口过了才发，撤销了不发，进程在这几秒里重启会丢

**去重**
- 在 `tasks.create`，调用方传 `dedupe: true` 才开，目前只有 MCP。手工表单（`POST /api/tasks`）永不去重。同一创建人 60 秒内指派对象、截止日相同、标题逐字相同、未完成且没归档的只存一条，靠 `INSERT ... SELECT ... WHERE NOT EXISTS`；并发时可能死锁，`create` 里重试
- 导入不走这条：重复只是灰显、默认不勾，人勾上就写
- 设置页的说明文案在 `settings.js` 的 `DEDUPE_RULE`，改规则要一起改，测试校验一字不差

**导入**
- 预览不写库，提交一个事务，要么全进要么全不进
- `@` 对不上时保留名字、指派留空，不拿默认指派顶替
- 会议复制出来的格式是 `标题 @负责人 MM-DD`（没有 `[ ]`，名字去了空格，见会议 `todoLine`），两种都要认
- `.csv` 才按逗号切，`.txt` 的中文句子里有逗号
- 图片和 PDF 明确拒绝，扩展名和文件头都查

**其他**
- 人名只在确认弹层和导入预览里预填，保存才写库
- 不改 MCP 工具名和参数，外部已在用。默认指派、默认截止不影响 MCP
- 定时推送要 `INBOX_DIGEST=1`，没开时设置页明说
- 上报（`ws.track`）不带原文
- 版本号：运行时只读 `yh-app.json`；`VERSION`、`package.json`、lock 靠测试校验一致，发版时四处一起改
- `src/yh-one.mjs` 是平台 SDK 的拷贝，不要改
