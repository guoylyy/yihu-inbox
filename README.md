# 收件箱 Inbox

以虎 One 官方应用：个人一句话记待办，团队派单，批量整理、导入、周报。Express 4 + EJS + 平台 SDK，MySQL 用 `mysql2/promise`，没有前端构建步骤。

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
E2E=1 npm test  # 接着跑 Playwright：独立实例 + 同一个临时库，经 /apps/inbox 前缀访问，截图在 artifacts/
../yihu-one/yh check . --strict

# 真实模型实测（需要平台给本应用的凭证和一个临时库）
YH_CLIENT_ID=… YH_CLIENT_SECRET=… YH_API_URL=<平台地址> DATABASE_URL=mysql://…/临时库 node scripts/real-model.mjs
```

## 文档

- `docs/使用说明.md`：给用户看的
- `CLAUDE.md`：结构、约定、测试
