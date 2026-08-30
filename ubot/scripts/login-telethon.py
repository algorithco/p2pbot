"""
Telethon (Python) QR login — strongest alternative to GramJS, no SMS needed.
Requires: pip install telethon qrcode[pil]

Usage:
  python scripts/login-telethon.py

Steps:
  1. Enter API_ID / API_HASH (from https://my.telegram.org) or set in ubot/.env
  2. Script shows QR code in terminal + tg://login?token=... URL
  3. On phone: Telegram → Settings → Devices → Link Desktop Device → Scan QR
  4. If 2FA, enter password when prompted
  5. Saves StringSession (Telethon format) — can be converted for teleproto/GramJS if needed,
     but for Python ubot use directly. For Node teleproto, use `npm run login:qr` instead.

This is the Python equivalent of `npm run login:qr` (teleproto) and is often more
reliable due to Telegram's new anti-spam blocking API code logins (issue gram-js#834).
QR bypasses SMS.
"""
import asyncio
import os
import sys

try:
    from telethon import TelegramClient
    from telethon.sessions import StringSession
except ImportError:
    print("Missing telethon. Run: pip install telethon qrcode[pil]")
    sys.exit(1)

# Try to read from ubot/.env if available
def load_env():
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k not in os.environ:
                    os.environ[k.strip()] = v.strip()
load_env()

API_ID = int(os.environ.get("API_ID", "0") or 0)
API_HASH = os.environ.get("API_HASH", "")

if not API_ID or not API_HASH:
    API_ID = int(input("API_ID (my.telegram.org): ").strip())
    API_HASH = input("API_HASH: ").strip()

async def main():
    print(f"API_ID={API_ID} API_HASH={API_HASH[:6]}****")
    # Telethon QR login
    client = TelegramClient(StringSession(), API_ID, API_HASH)
    await client.connect()

    if await client.is_user_authorized():
        print("Already authorized as", await client.get_me())
        print("Session:", client.session.save())
        return

    # QR login — Telethon's qr_login returns object with .url and .wait()
    qr_login = await client.qr_login()
    qr_url = qr_login.url  # type: ignore[attr-defined]
    print("\n=== QR ===")
    print("1) Telegram → Settings → Devices → Link Desktop Device → Scan QR")
    print(f"URL: {qr_url}")
    try:
        import qrcode  # type: ignore
        qr = qrcode.QRCode()
        qr.add_data(qr_url)
        qr.print_ascii(invert=True)
    except ImportError:
        print(f"Or open in browser: https://api.qrserver.com/v1/create-qr-code/?data={qr_url}")

    print("\nWaiting for scan (30s per QR, auto-refreshes)...")
    try:
        await qr_login.wait()  # blocks until scanned or 2FA needed
    except Exception as e:
        # Handle 2FA
        msg = str(e)
        if "SessionPasswordNeeded" in msg or "password" in msg.lower():
            print("2FA required")
            pwd = os.environ.get("TWO_FA_PASSWORD", "") or input("2FA password: ")
            try:
                # Telethon after QR needs sign-in with password: use sign_in with password
                await client.sign_in(password=pwd)
            except Exception as e2:
                print(f"2FA failed: {e2}")
                return
        elif "Timeout" in msg or "expired" in msg.lower():
            print(f"QR expired / timeout: {e}")
            return
        else:
            # For other errors, try is_user_authorized check
            if not await client.is_user_authorized():
                print(f"QR login failed: {e}")
                return
    
    print("\n✔ QR login success!")
    me = await client.get_me()
    print(f"Logged in as: {me.username or me.first_name} (id {me.id})")
    session_str = client.session.save()
    print("\nStringSession (Telethon format, keep secret):")
    print(session_str)
    print("\nFor Node teleproto ubot, you need teleproto StringSession — run `npm run login:qr` instead,")
    print("or convert Telethon session via: https://docs.telethon.dev/...")
    print("For Python ubot, use this session directly in ubot_py.")

    # Save encrypted? For Python we just print; user can add to ubot/.env as TELETHON_SESSION
    # Optionally save to file
    save = input("\nSave to ubot.session.telethon? (y/n): ").strip().lower()
    if save.startswith("y"):
        with open(os.path.join(os.path.dirname(__file__), "..", "sessions", "ubot.session.telethon"), "w", encoding="utf-8") as f:
            f.write(session_str)
        print("Saved")

    await client.disconnect()

if __name__ == "__main__":
    asyncio.run(main())
