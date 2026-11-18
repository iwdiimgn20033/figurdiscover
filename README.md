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

## متغيرات Railway (Variables)
- `ANTHROPIC_API_KEY` : مفتاح المساعد الذكي (اختياري).
