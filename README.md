# 收件箱 Inbox

以虎 One 官方应用：个人一句话记待办，团队派单。Express 4 + EJS + 平台 SDK，MySQL 用 `mysql2/promise`，没有前端构建步骤。

## 本地运行

```bash
cp .env.example .env   # 填 DATABASE_URL
npm install
node --env-file=.env src/server.js
```

不配 `YH_*` 时以「本地用户」单人运行，只在 `NODE_ENV` 不是 `production` 时生效；生产环境没配平台凭证会拒绝服务，不退回匿名。

## 测试

```bash
npm test     # 真实 MySQL：没给 TEST_DATABASE_URL 就用 Docker 起临时库，跑完删掉
npm run e2e  # Playwright：独立实例（3050）+ 临时库，经 /apps/inbox 前缀访问，截图在 artifacts/e2e/
../yihu-one/yh check . --strict

# 真实模型实测（需要平台给本应用的凭证和一个临时库）
YH_CLIENT_ID=… YH_CLIENT_SECRET=… YH_API_URL=<平台地址> DATABASE_URL=mysql://…/临时库 node scripts/real-model.mjs
```

## 约定

- 权限只在 `src/tasks.js`：看得到的是自己创建的和指派给自己的，其余 404；被指派人只能完成 / 重开，改别的 403
- 版本号只写在 `yh-app.json` 和 `package.json`，页面、`/health`、MCP 都读清单
- 日期只在 `src/dates.js` 里算，「今天」按 `INBOX_TZ`（默认 Asia/Shanghai），不用数据库的 `CURDATE()`
- 改表：`src/db.js` 的 `ADDED_COLUMNS` 登记新列，要可空或有默认值（回滚不回库）
- 去重在 `tasks.create`：同一人 60 秒内标题逐字相同、未完成、截止日相同的只存一条，靠 `INSERT ... SELECT ... WHERE NOT EXISTS`；并发时可能死锁，`create` 里重试
- 人名只在确认弹层预填（`matchAssignee`），保存才写库
- `src/yh-one.mjs` 是平台 SDK 的拷贝，不要改
- `tags` 列和 `source='app'` 留给 v0.2，v0.1 不写入
