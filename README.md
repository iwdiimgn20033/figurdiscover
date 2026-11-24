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
