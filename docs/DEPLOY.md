# Deploying Rivo

Rivo on one Ubuntu server: a single Node process behind nginx (HTTPS, the live
connection), PostgreSQL on the same machine. 1 vCPU and 2 GB of RAM are plenty
for a small group (the load test: 400 people chatting used 14% of a laptop's core
and 160 MB). Written against Ubuntu 26.04 (Node 24, PostgreSQL 18, nginx 1.28);
24.04 works the same.

In the commands, `DOMAIN` is the site's address (e.g. `rivo.example.com`), `IP`
the server's IPv4 address, and `OWNER/REPO` the GitHub repository.

---

## 1. The server

As root, once:

```bash
apt update && apt upgrade -y && reboot

adduser arvin                    # your own user (any name); work as it from now on
usermod -aG sudo arvin

ufw allow OpenSSH                # (or your SSH port, if it is not 22)
ufw allow 80,443/tcp
ufw enable

fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Rivo listens on port 3000; the firewall keeps it closed from outside, and only
nginx (on the same machine) talks to it.

## 2. Software

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs postgresql nginx git certbot python3-certbot-nginx
node -v                          # v24.x (Rivo needs 22.18 or later; CI uses 24)
```

## 3. The domain

At the domain's DNS: an **A** record from `DOMAIN` to `IP`, with any CDN / proxy
**off** ("DNS only": nginx and Let's Encrypt on the server do HTTPS themselves, and
the live connection goes straight to it) and a short TTL (5 minutes) while setting
up. Check: `dig +short DOMAIN @8.8.8.8` prints `IP`.

## 4. The database

```bash
openssl rand -hex 24             # the database password: keep it for .env
# (a command starting with a space is not kept in the shell's history)
 sudo -u postgres psql -c "CREATE USER rivo WITH PASSWORD 'DB_PASSWORD';"
 sudo -u postgres psql -c "CREATE DATABASE rivo OWNER rivo;"
```

## 5. The code

A private repository is cloned with a **deploy key**: a key of the server's own
that can only read this one repository.

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keygen -t ed25519 -f ~/.ssh/github_rivo -N "" -C "rivo server"
cat >> ~/.ssh/config <<'CONF'
Host github.com
	IdentityFile ~/.ssh/github_rivo
	IdentitiesOnly yes
CONF
cat ~/.ssh/github_rivo.pub
```

GitHub → the repository → Settings → Deploy keys → Add deploy key: paste it,
leave "Allow write access" off. Then:

```bash
ssh -T git@github.com            # "Hi OWNER/REPO! You've successfully authenticated…"
git clone git@github.com:OWNER/REPO.git ~/rivo
cd ~/rivo
```

(A public repository: `git clone https://github.com/OWNER/REPO.git ~/rivo`.)

## 6. Packages

```bash
npm ci
```

Never set `NODE_ENV=production` in the shell: npm would leave out the build tools
(devDependencies). Production is set where Rivo runs: in `.env` and in the service.

## 7. The settings (.env)

```bash
cp deploy/env.production.example .env
sed -i "s/__DOMAIN__/DOMAIN/g" .env
chmod 600 .env                   # only your user can read it
openssl rand -hex 32             # → JWT_SECRET
npm run gen-kek                  # → KEK_V1
npm run gen-vapid                # → VAPID_PUBLIC and VAPID_PRIVATE
nano .env                        # fill in the empty values
```

- `DATABASE_URL`: the password from step 4 in place of `DB_PASSWORD`.
- `SMTP_*`: a Gmail address and an **App Password** for it (Google account →
  Security → 2-Step Verification on → App passwords): sign-up codes and password
  resets are sent from it.
- **`KEK_V1`: keep a copy off the server** (a password manager). Messages are stored
  encrypted with it: without it, they cannot be read again, from the database or from
  a backup. Never change it on a running server (key rotation: `server/ENCRYPTION.md`).

## 8. Database tables and the build

```bash
npx prisma migrate deploy
npm run build                    # the pages carry APP_URL: build again after changing it
npm run check-kek && npm run check-vapid
```

## 9. The service

Rivo as a system service: started at boot, restarted if it stops.

```bash
sed -e "s|__USER__|$USER|g" -e "s|__DIR__|$PWD|g" deploy/rivo.service | sudo tee /etc/systemd/system/rivo.service
sudo systemctl daemon-reload
sudo systemctl enable --now rivo
systemctl status rivo --no-pager
curl -s http://127.0.0.1:3000/api/health          # {"status":"ok","db":"ok",…}
```

## 10. nginx

```bash
sed "s/__DOMAIN__/DOMAIN/g" deploy/nginx.conf | sudo tee /etc/nginx/sites-available/rivo
sudo ln -s /etc/nginx/sites-available/rivo /etc/nginx/sites-enabled/rivo
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

`http://DOMAIN` now shows Rivo's landing page (logging in needs HTTPS: the next step).

## 11. HTTPS

```bash
sudo certbot --nginx -d DOMAIN --redirect --agree-tos --no-eff-email -m YOU@gmail.com -n
sudo certbot renew --dry-run     # renewal works (it runs by itself: certbot.timer)
```

certbot adds the certificate to `/etc/nginx/sites-available/rivo` and sends
`http://` to `https://`.

## 12. Check

- `https://DOMAIN`: the landing page; `https://DOMAIN/chat/`: sign up. The code
  arrives by email (else: `journalctl -u rivo -n 50` says why).
- Two accounts in two browsers: messages arrive live, "typing…", seen.
- Notifications: turn them on in Settings, close the tab, get a message.

## 13. Backups

The database and the profile pictures, every night, the last 14 days kept
(`scripts/backup-db.sh`):

```bash
mkdir -p ~/rivo/backups
(crontab -l 2>/dev/null; echo '30 3 * * * cd ~/rivo && bash scripts/backup-db.sh >> backups/backup.log 2>&1') | crontab -
bash scripts/backup-db.sh        # once now, to see it work
```

A backup on the same server is lost with it: now and then, from your computer,
`scp -r arvin@IP:~/rivo/backups .` (Windows: in PowerShell). The dumps are useless
without `KEK_V1` (step 7), which is kept apart from them.

## 14. SSH with a key only

From your computer (Windows, PowerShell), once there is a key (`ssh-keygen -t ed25519`):

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh arvin@IP "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
ssh arvin@IP                     # must log in without asking for the password
```

Only then, on the server:

```bash
printf 'PasswordAuthentication no\nPermitRootLogin no\n' | sudo tee /etc/ssh/sshd_config.d/10-rivo.conf
sudo sshd -t && sudo systemctl restart ssh
```

Keep the open session until a **new** window logs in with the key. (`10-` sorts
before a cloud image's own `50-cloud-init.conf`, and the first value read wins.)

---

## Updating

```bash
cd ~/rivo && bash scripts/deploy.sh
```

Pull, `npm ci`, migrations, build, restart, health check; it stops at the first
step that fails.

## When something is wrong

| What you see | Where to look |
|---|---|
| 502 Bad Gateway | Rivo is not running: `systemctl status rivo`, `journalctl -u rivo -n 100` |
| Rivo stops right after starting | Its log names the missing setting (`journalctl -u rivo -n 30`) |
| 413 on a profile picture | nginx's `client_max_body_size` (6m in `deploy/nginx.conf`) |
| nginx does not reload | `sudo nginx -t` shows the line |
| No sign-up email | `journalctl -u rivo` (SMTP's answer); the App Password; outgoing port 587 open |
| Everyone is "rate limited" at once | `ENABLE_TRUST_PROXY=1` is missing from `.env` |

## Shutting it down

A last backup (`bash scripts/backup-db.sh`), copied to your computer with `KEK_V1`;
then delete the server and the domain's A record.
