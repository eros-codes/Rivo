# Rivo

پیام‌رسان بلادرنگ: Express 5 + Socket.IO + Prisma (Postgres) در سرور، React 19 +
TypeScript در مرورگر. هر دو TypeScript‌اند و از یک قرارداد مشترک (`shared/`: شکل
داده‌ها، رویدادها، و schemaهای zod که سرور هر ورودی را با آن‌ها چک می‌کند) می‌خوانند.

## راه‌اندازی

```bash
cp .env.example .env          # (یا .env قبلی‌ات را کپی کن) و مقدارها را پر کن
npm install
npx prisma migrate deploy
npm run build
npm start                      # http://localhost:3000
```

برای توسعه: `npm run dev` (ساخت پیوسته‌ی کلاینت + ری‌استارت سرور). داده‌ی تست:
`npm run db:seed` (۱۶ نفر با چت‌هایشان؛ `-- --wipe` اول همه‌چیز را پاک می‌کند).

## تست و کیفیت

```bash
npm run check                      # همه‌ی زیر، پشت سر هم (قبل از commit)
npm run typecheck && npm run lint
npm run test:unit                  # بدون دیتابیس
npm run test:api                   # نیاز: TEST_DATABASE_URL (دیتابیسی فقط برای تست)
npm run build && npm run test:e2e  # مرورگر (یک‌بار: npx playwright install chromium)
```

تست‌ها هم TypeScript‌اند و با همان قرارداد `shared/` چک می‌شوند (unit ۳۴، api ۴۲،
مرورگر ۳۷). همین‌ها با هر push روی GitHub Actions هم اجرا می‌شوند (`.github/workflows/ci.yml`)،
تست‌های مرورگر آن‌جا در Firefox و WebKit (Safari) هم.

## عملیات

`GET /api/health` برای پایش، `npm run db:backup` / `db:restore` برای بکاپ، و
`npm run db:check` قبل از migrationها. جزئیات: بخش‌های ۷ تا ۹ مستندات. کلیدهای
رمزنگاری، چرخش کلید و Vault: [`server/ENCRYPTION.md`](server/ENCRYPTION.md).

## مستندات

همه‌چیز — ساختار پوشه‌ها، پروتکل همگام‌سازی، نشست‌ها و CSRF، rate limitها، حریم
خصوصی، outbox و undo، نکات به‌روزرسانی از نسخه‌ی قبلی و تست‌ها — در
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) است.
