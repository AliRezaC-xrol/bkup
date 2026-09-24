import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import { resolveText } from "@/lib/messages";

/**
 * v1.3.0 made every NEW log line English, but older releases (v1.0.0–v1.2.0)
 * wrote Persian messages into SQLite. Those historical rows keep rendering
 * Persian in the web console forever, so on boot we translate every stored
 * message whose displayed (English) side still contains Persian characters.
 *
 * The map covers every Persian string literal that ever existed in src/
 * across all release tags, plus regex rules for the few interpolated ones.
 * A row that somehow escapes both (dynamic composition) is dropped rather
 * than left Persian — the requirement is that every visible log is English.
 */

const PERSIAN = /[\u0600-\u06FF]/;

/** Legacy Persian string → its English equivalent. */
const MAP: Record<string, string> = {
  "آدرس HMPanel تنظیم نشده است": "HMPanel address is not configured",
  "آدرس PasarGuard تنظیم نشده است": "PasarGuard address is not configured",
  "آدرس Rebecca تنظیم نشده است": "Rebecca address is not configured",
  "آدرس پنل تنظیم نشده است": "Panel address is not configured",
  "آدرس پنل را وارد کنید": "Enter the panel address",
  "آیدی چت تلگرام تنظیم نشده است": "Telegram chat ID is not configured",
  "آیدی چت تلگرام را وارد کنید": "Enter the Telegram chat ID",
  "اتصال رد شد (سرویس HMPanel در دسترس نیست)": "Connection rejected (HMPanel service is not reachable)",
  "اتصال رد شد (سرویس PasarGuard در دسترس نیست)": "Connection rejected (PasarGuard service is not reachable)",
  "اتصال رد شد (سرویس Rebecca در دسترس نیست)": "Connection rejected (Rebecca service is not reachable)",
  "اتصال رد شد (پنل در دسترس نیست)": "Connection rejected (panel is not reachable)",
  "اجرای بکاپ با ریاستارت سرویس قطع شد": "The backup run was interrupted by a service restart",
  "اجرای قبلی هنوز در جریان است؛ این تیک رد شد": "The previous run is still in progress; this tick was skipped",
  "اجرای قبلی هنوز در حال انجام است — این چرخه رد شد": "The previous cycle has not finished yet; this backup cycle was skipped",
  "ارسال به تلگرام ناموفق بود": "Sending to Telegram failed",
  "ارسال قطع شد — فایل ممکن است رسیده باشد؛ برای جلوگیری از ارسال تکراری، دوباره تلاش نشد":
    "Sending was interrupted — the file may have arrived; no retry was attempted to avoid a duplicate send",
  "این حساب PasarGuard غیرفعال شده است": "This PasarGuard account has been disabled",
  "بهروزرسانی بدون از دست رفتن دیتا:": "Update without data loss:",
  "بکاپ HMPanel ناموفق بود": "HMPanel backup failed",
  "بکاپ PasarGuard ناموفق بود": "PasarGuard backup failed",
  "بکاپ Rebecca در این نصب غیرفعال است (فقط نصب باینری)": "Rebecca backup is disabled in this installation (binary install only)",
  "بکاپ Rebecca ناموفق بود": "Rebecca backup failed",
  "بکاپ دستی توسط کاربر آغاز شد": "A manual backup was started by the user",
  "بکاپ کامل (دیتابیس + تنظیمات + آپلودها)": "Full backup (database + settings + uploads)",
  "بکاپ کامل (کاربران + هاستها + نودها + کورها + گروهها + تنظیمات)": "Full backup (users + hosts + nodes + cores + groups + settings)",
  "تست اتصال": "Connection test",
  "تست تلگرام": "Telegram test",
  "تعداد تلاشهای ورود زیاد است (محدودیت سرور پنل) — یک دقیقه بعد دوباره امتحان کنید":
    "Too many sign-in attempts (panel server limit) — try again in a minute",
  "تلاش ناموفق برای ورود به پنل وب": "A failed sign-in attempt on the web panel",
  "تنظیمات HMPanel از نسخه قبلی به کارت مستقل پنل منتقل شد": "HMPanel settings were migrated from the previous version to the dedicated panel card",
  "تنظیمات از فایل وارد شد": "Settings were imported from a file",
  "تنظیمات بهروزرسانی شد": "Settings updated successfully",
  "تنظیمات در فایلی ذخیره شد (همراه اعتبارنامهها)": "Settings were exported to a file (with credentials)",
  "تنظیمات در فایلی ذخیره شد": "Settings were exported to a file",
  "توکن API را وارد کنید": "Enter the API token",
  "توکن بات تلگرام تنظیم نشده است": "Telegram bot token is not configured",
  "توکن بات تلگرام را وارد کنید": "Enter the Telegram bot token",
  "حالت احراز هویت نامعتبر است": "Invalid authentication mode",
  "حالت بکاپ نامعتبر است": "Invalid backup mode",
  "حجم فایل بیش از حد مجاز تلگرام (50MB) است": "The file is larger than Telegram's 50MB limit",
  "خروجی JSON": "JSON output",
  "خطای ناشناخته هنگام ذخیره تنظیمات": "Unknown error while saving settings",
  "خطای نامشخص در ذخیره تنظیمات": "Unknown error while saving settings",
  "خطای نامشخص": "Unknown error",
  "دانلود بکاپ Rebecca مجاز نشد (دسترسی ادمین لازم است)": "Rebecca backup download not allowed (admin access required)",
  "دانلود بکاپ مجاز نشد (دسترسی SUPER_ADMIN لازم است)": "Backup download not allowed (SUPER_ADMIN access required)",
  "دانلود دیتابیس ناموفق بود": "Database download failed",
  "سشن پذیرفته نشد — مسیر پایه یا مشخصات را بررسی کنید": "Session rejected — check the base path or credentials",
  "فاصله بکاپ باید بین ۱۰ ثانیه تا ۲۴ ساعت باشد": "Backup interval must be between 10 seconds and 24 hours",
  "فاصله بکاپگیری باید بین ۱۰ ثانیه و ۲۴ ساعت باشد": "Backup interval must be between 10 seconds and 24 hours",
  "فایل بهعنوان JSON تنظیمات خوانده نشد": "The file could not be read as a settings JSON",
  "فایل بکاپ Rebecca خالی بود": "The Rebecca backup file was empty",
  "فایل بکاپ خالی بود": "The backup file was empty",
  "فایل بکاپ ساختار gzip معتبر ندارد": "The backup file does not have a valid gzip structure",
  "فایل بکاپ ساختار zip معتبر ندارد": "The backup file does not have a valid zip structure",
  "فایل بکاپ پیدا نشد": "Backup file not found",
  "فایل دیتابیس (لوکال)": "Database file (local)",
  "فایل دیتابیس خالی بود": "The database file was empty",
  "فایل دیتابیس": "Database file",
  "مسیر فایل دیتابیس لوکال تنظیم نشده است": "The local database file path is not configured",
  "مهلت اتصال به پایان رسید": "Connection deadline expired",
  "نام کاربری و رمز عبور HMPanel را وارد کنید (حساب SUPER_ADMIN)": "Enter the HMPanel username and password (SUPER_ADMIN account)",
  "نام کاربری و رمز عبور PasarGuard را وارد کنید (حساب ادمین)": "Enter the PasarGuard username and password (admin account)",
  "نام کاربری و رمز عبور Rebecca را وارد کنید (حساب ادمین)": "Enter the Rebecca username and password (admin account)",
  "نام کاربری و رمز عبور پنل را وارد کنید": "Enter the panel username and password",
  "نامشخص": "Unknown",
  "هاست پیدا نشد": "Host not found",
  "هیچ تنظیمات شناختهشدهای در این فایل پیدا نشد": "No recognized settings were found in this file",
  "هیچ پنلی فعال نیست — ابتدا اتصال 3x-ui، HMPanel یا PasarGuard را در تنظیمات فعال کنید":
    "No panel is enabled — first enable a 3x-ui, HMPanel or PasarGuard connection in Settings",
  "هیچ پنلی فعال نیست — ابتدا اتصال یکی از پنلها را در تنظیمات فعال کنید": "No panel is enabled — first enable a panel connection in Settings",
  "ورود به HMPanel ناموفق بود — نام کاربری/رمز عبور اشتباه است یا این حساب ادمین کل (SUPER_ADMIN) نیست":
    "HMPanel sign-in failed — wrong username/password or this is not the super admin (SUPER_ADMIN) account",
  "ورود به PasarGuard ناموفق بود — نام کاربری یا رمز عبور اشتباه است": "PasarGuard sign-in failed — wrong username or password",
  "ورود به Rebecca ناموفق بود — نام کاربری/رمز عبور اشتباه است یا این حساب غیرفعال شده":
    "Rebecca sign-in failed — wrong username/password or the account has been disabled",
  "ورود به پنل ناموفق بود": "Panel sign-in failed",
  "پاسخ HMPanel فاقد شناسه فایل بکاپ بود": "The HMPanel response was missing the backup file id",
  "پاسخ JSON بهجای فایل دیتابیس": "The panel answered with JSON instead of the database file",
  "پاسخ Rebecca بهجای فایل بکاپ، JSON بود": "Rebecca answered with JSON instead of the backup file",
  "پسورد پنل وب تغییر کرد": "The web panel password was changed",
  "پسورد پنل وب ساخته شد (setup اولیه)": "The web panel password was created (initial setup)",
  "پنل 3x-ui": "3x-ui panel",
  "پنل بهجای فایل بکاپ پیام خطا برگرداند": "The panel returned an error message instead of the backup file",
  "پنل کوکی سشن برنگرداند": "The panel did not return the session cookie",
  "پیام تست با موفقیت به تلگرام ارسال شد": "The test message was sent to Telegram successfully",
  "چرخه قبلی هنوز تمام نشده؛ بکاپ این دوره رد شد": "The previous cycle has not finished yet; this backup cycle was skipped",
  "چرخهٔ بکاپ تکراری در همان بازهٔ زمانبندی سرکوب شد": "A duplicate backup cycle within the same scheduling window was suppressed",
  "گواهی SSL نامعتبر است (گزینه نادیدهگرفتن SSL را فعال کنید)": "The SSL certificate is invalid (enable the ignore-SSL option)",
  "• وبپنل → سیستم → بهروزرسانی از گیتهاب": "• Web panel → System → Update from GitHub",
  "• یا ترمینال: bkup → گزینه 7": "• Or terminal: bkup → option 7",
  "✅ اتصال بات bkup برقرار است.\nاز این پس بکاپها به این چت ارسال میشوند.":
    "✅ The bkup bot connection is established.\nBackups will be sent to this chat from now on.",
  "🗄 بکاپ خودکار 3X-UI": "🗄 Automatic backup 3X-UI",
  "🗄 بکاپ خودکار HM Panel": "🗄 Automatic backup HM Panel",
  "🗄 بکاپ خودکار PasarGuard": "🗄 Automatic backup PasarGuard",
};

// The one interpolated legacy template worth keeping (its tail is a value,
// not prose): "سرویس با دستور «restart» از پنل وب کنترل شد"
const RULES: Array<[RegExp, string]> = [
  [
    /^سرویس با دستور «(.+?)» از پنل وب کنترل شد$/,
    'The service was controlled from the web panel with the "$1" command',
  ],
];

// Longest-first so the most specific key wins when several prefix-match.
const PREFIX_KEYS = Object.keys(MAP)
  .filter((k) => k.length >= 8 && MAP[k] !== "")
  .sort((a, b) => b.length - a.length);

/**
 * Translate one legacy Persian message to English.
 * Returns null when the text is not Persian or no rule covers it.
 */
export function translateLegacyPersian(text: string): string | null {
  if (!PERSIAN.test(text)) return null;
  const t = text.trim();
  const direct = MAP[t];
  if (direct) return direct;
  for (const [re, to] of RULES) {
    if (re.test(t)) return t.replace(re, to);
  }
  for (const key of PREFIX_KEYS) {
    if (t.startsWith(key)) return MAP[key] + t.slice(key.length);
  }
  return null;
}

/**
 * One-time-per-boot sweep over every text field that can still hold a
 * legacy Persian message: the AppLog console, backup-run errors and restore
 * job errors. Fire-and-forget from bootstrapScheduler.
 */
export async function translateLegacyLogs(): Promise<void> {
  try {
    let translated = 0;
    let removed = 0;

    const logs = await db.appLog.findMany({ select: { id: true, message: true } });
    for (const row of logs) {
      const shown = resolveText(row.message, "en");
      if (!PERSIAN.test(shown)) continue;
      const eng = translateLegacyPersian(shown);
      if (eng) {
        await db.appLog.update({ where: { id: row.id }, data: { message: eng } });
        translated++;
      } else {
        // untranslatable dynamic leftover — dropping beats showing Persian
        await db.appLog.delete({ where: { id: row.id } });
        removed++;
      }
    }

    const fallback = "Legacy error (the original message was not in English)";
    const fixErrors = async (
      rows: { id: number; error: string | null }[],
      update: (id: number, error: string) => Promise<unknown>
    ) => {
      for (const row of rows) {
        if (!row.error) continue;
        const shown = resolveText(row.error, "en");
        if (!PERSIAN.test(shown)) continue;
        await update(row.id, translateLegacyPersian(shown) ?? fallback);
        translated++;
      }
    };

    await fixErrors(
      await db.backupRun.findMany({ where: { error: { not: null } }, select: { id: true, error: true } }),
      async (id, error) => db.backupRun.update({ where: { id }, data: { error } })
    );
    await fixErrors(
      await db.restoreJob.findMany({ where: { error: { not: null } }, select: { id: true, error: true } }),
      async (id, error) => db.restoreJob.update({ where: { id }, data: { error } })
    );

    if (translated > 0 || removed > 0) {
      console.log(`[LOG-ENGLISH] ${translated} legacy message(s) translated to English, ${removed} untranslatable log row(s) removed`);
      await log(
        "success",
        `Legacy non-English entries were converted to English (${translated} translated, ${removed} removed)`
      );
    }
  } catch (e) {
    console.error("[LOG-ENGLISH] legacy log translation failed:", e);
  }
}
