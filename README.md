# figurdiscover

موقع التحليل المالي والإحصائي — figurdiscover.com

- `index.html` : الموقع كاملاً في ملف واحد (فيه إعدادات Firebase في أعلى الملف: FIGUR_FIREBASE).
- `server.js` : خادم الموقع على Railway: يعرض الموقع، ويجلب الأسعار، ويحلل ردات فعل الأسواق، ويتحقق من اشتراك PRO، ويشغّل المساعد الذكي.
- `package.json` : يخبر Railway كيف يشغّل الخادم.
- `firestore.rules` : قواعد حماية قاعدة بيانات Firestore؛ تُلصق في Firebase > Firestore Database > Rules ثم Publish.

## الحسابات والاشتراكات (Firebase)
- الدخول بالبريد وكلمة المرور: Firebase > Authentication.
- بيانات المستخدمين: Firestore > المجموعة `user_data` (مستند لكل مستخدم باسم رقمه UID).
- اشتراك PRO: Firestore > المجموعة `subscriptions` > مستند باسم UID المستخدم، فيه:
  - `status` (string): `trialing` للتجربة أو `active` للاشتراك المدفوع
  - `current_period_end` (timestamp): تاريخ انتهاء التجربة أو الشهر

## الدفع عبر PayPal
- في `index.html` داخل `PRO_CFG.paypal`: `clientId` (Client ID الحي) و`planId` (رقم خطة الاشتراك P-...).
- بعد الدفع يُحفظ رقم اشتراك PayPal في Firestore > `paypal/{UID}`، والخادم يتحقق منه مباشرة مع PayPal.

## متغيرات Railway (Variables)
- `PAYPAL_CLIENT_ID` و`PAYPAL_CLIENT_SECRET` : من PayPal Developer > Apps & Credentials (Live).
- `PAYPAL_PLAN_ID` : رقم الخطة P-... (اختياري، لزيادة الأمان).
- `ANTHROPIC_API_KEY` : مفتاح المساعد الذكي (اختياري).

## الاشتراكات (يدوياً عبر PayPal)
- تجربة مجانية 3 ساعات لكل حساب (يمكن تغييرها بمتغير Railway: `TRIAL_HOURS`).
- PRO أسبوعي 3.99$، ومؤشر FD Scalper + الشارت 6.99$ شهرياً، أو الاثنان معاً.
- المشترك يرفع إيصال الدفع من نافذة الاشتراك، والمشرف يفعّله من صفحة `#admin`.
- مجلد `indicators/` فيه كود المؤشر لـ TradingView وMT5، ولا يُحمَّل إلا للمشتركين.
- لحفظ الإيصالات والاشتراكات بشكل دائم أضف Volume في Railway على المسار `/data`.

## Capital.com live candles (US Tech 100 + Gold)
Railway → Variables:
- `CAPITAL_API_KEY` — the API key from Capital.com (Settings → API integrations)
- `CAPITAL_EMAIL` — your Capital.com login email
- `CAPITAL_PASSWORD` — the custom password you set for the API key
- optional `CAPITAL_ENV=live` (default is demo), `CAPITAL_EPIC_NAS` (default US100), `CAPITAL_EPIC_GOLD` (default GOLD)
Check: open https://figurdiscover.com/api/capital/status?test=1

## Customer wallet, orders and auto-trading
- Each subscriber links their own Capital.com account from the indicator page. Credentials are encrypted with AES-256-GCM.
- Railway → Variables: `TRADE_SECRET` = any long random text (encryption key). Do not change it later, or saved links stop working.
- A Railway Volume mounted at `/data` is required so links, bot settings and trade logs survive deploys.
- Orders are placed only by the user (auto-trading removed).

## Owner AI trading bot (#aibot)
- Owner only (ADMIN_EMAILS / ADMIN_UIDS). Paper mode by default.
- Signals: Khamisehawi engine (closed 1-minute candles) + TradingView webhook `/api/bot/tv?key=...`.
- Filter: Claude via `ANTHROPIC_API_KEY` (optional `ANTHROPIC_MODEL`); rule filter without a key.
- Venues: Capital.com (owner's linked wallet account), MetaTrader 5 / CFI (EA `indicators/Khamisehawi_AI_Bot.mq5`, downloaded from the bot page with the key inside), Binance USDⓈ-M futures (`BINANCE_KEY`, `BINANCE_SECRET`, `BINANCE_TESTNET=0` for live; needs a non-US Railway region).
- Optional `BOT_KEY` to set the webhook / EA key yourself.
