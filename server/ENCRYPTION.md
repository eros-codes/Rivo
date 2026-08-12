Encryption at rest (DEK/KEK) — Rivo
=================================

خلاصه
------
- معماری: هر پیام با یک DEK (256-bit) با `AES-256-GCM` رمز می‌شود. DEK سپس با یک KEK سروری (Envelope Encryption) با همان الگوریتم بسته‌بندی می‌شود.
- رکوردهای پیام در دیتابیس ستون‌های `ciphertext`, `iv`, `auth_tag`, `wrapped_dek`, `key_id` را نگه می‌دارند. فیلد `text` به‌صورت legacy/nullable است.

فایل‌های مرتبط
----------------
- `server/utils/encryption.js` — توابع اصلی رمزنگاری و `initKeyStore()` برای خواندن KEK از Vault یا fallback به env: [server/utils/encryption.js](server/utils/encryption.js)
- اسکریپت‌ها:
  - `server/scripts/push_keks_to_vault.js` — آپلود KEK‌ها به Vault (interactive + dry‑run): [server/scripts/push_keks_to_vault.js](server/scripts/push_keks_to_vault.js)
  - `server/scripts/mock_vault_server.js` — mock Vault محلی برای تست: [server/scripts/mock_vault_server.js](server/scripts/mock_vault_server.js)
  - `server/scripts/rotate_keys.js` — چرخش کلیدها (dry‑run و batch): [server/scripts/rotate_keys.js](server/scripts/rotate_keys.js)
  - `server/scripts/insert_persistent_message.js` — درج پیام تست برای چرخش: [server/scripts/insert_persistent_message.js](server/scripts/insert_persistent_message.js)
  - `server/scripts/verify_decrypted_after_rotation.js` — بررسی بازگشایی پیام پس از چرخش: [server/scripts/verify_decrypted_after_rotation.js](server/scripts/verify_decrypted_after_rotation.js)
  - `server/scripts/test_message_encryption.js` — تست E2E رمز/بازگشایی: [server/scripts/test_message_encryption.js](server/scripts/test_message_encryption.js)
- مسیرهای API/socket: `server/routes/messages.js`, `server/socket/index.js` (رمزنگاری قبل از ذخیره؛ بازگشایی در خواندن): [server/routes/messages.js](server/routes/messages.js) — [server/socket/index.js](server/socket/index.js)

راه‌اندازی Vault (نمونه HashiCorp Vault KV v2)
----------------------------------------------
1. Vault را آماده کن (production: از managed KMS یا یک Vault امن استفاده کن). در مثال محلی از mount=`secret`, path=`rivo` استفاده می‌کنیم.
2. KEKها را تولید کن (32 بایت، base64 یا hex):
   ```powershell
   node -p "require('crypto').randomBytes(32).toString('base64')"
   ```
3. KEKها را داخل Vault قرار بده (روش‌ها):
   - با Vault CLI:
     ```bash
     vault kv put secret/rivo KEK_V1=<base64_KekV1> KEK_V2=<base64_KekV2>
     ```
   - یا از helper داخل repo استفاده کن (interactive):
     ```powershell
     $env:VAULT_ADDR='http://127.0.0.1:8200'
     $env:VAULT_TOKEN='s.xxxxx'
     node server/scripts/push_keks_to_vault.js
     ```

راه‌اندازی و چک‌کردن محلی (گام‌های پیشنهادی)
---------------------------------------------
1. (اختیاری) برای تست لوکال یک mock Vault اجرا کن:
   ```powershell
   node server/scripts/mock_vault_server.js
   ```
2. KEKها را در Vault قرار بده (یا از env برای dev استفاده کن).
3. سرور را بالا بیاور:
   ```powershell
   npm run server
   ```
4. اسکریپت تست رمزنگاری را اجرا کن:
   ```powershell
   node server/scripts/test_message_encryption.js
   ```
5. چرخش کلید (همیشه ابتدا dry‑run):
   ```powershell
   node server/scripts/rotate_keys.js --from v1 --to v2 --batch 100 --dry-run
   # پس از بازبینی و گرفتن backup:
   node server/scripts/rotate_keys.js --from v1 --to v2 --batch 100
   ```
6. صحت پیام‌های چرخش‌شده را بررسی کن:
   ```powershell
   node server/scripts/verify_decrypted_after_rotation.js
   ```

نکات عملی و ایمنی (مهم)
------------------------
- در production KEKها را هرگز در `.env` یا repository قرار نده. از Vault یا managed KMS استفاده کن.
- قبل از اجرای هر چرخش واقعی، گرفتن backup کامل از دیتابیس اجباری است.
- ابتدا همیشه `--dry-run` را اجرا کن و خروجی را بررسی کن تا از بی‌خطر بودن چرخش مطمئن شوی.
- دسترسی به Vault باید محدود و audit شده باشد؛ توکن Vault را در CI/Secrets store امن نگهدار.
- نگه داشتن `mock_vault_server.js` برای توسعه محلی مفید است، اما آن را در محیط production اجرا نکن.
