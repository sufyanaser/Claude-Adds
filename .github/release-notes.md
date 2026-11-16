## التنزيل

| النظام | الملف | ملاحظات |
|---|---|---|
| Windows 11 | `Claude-Adds-<version>-setup.exe` | مُثبِّت. هذه النسخة تحدّث نفسها تلقائيًا. |
| Windows 11 | `Claude-Adds-<version>-portable.exe` | محمول دون تنصيب. يُشعرك بالتحديث ولا يحدّث نفسه. |
| macOS (Apple Silicon) | `Claude-Adds-<version>-mac-arm64.dmg` | يُشعرك بالتحديث ولا يحدّث نفسه. |
| macOS (Intel) | `Claude-Adds-<version>-mac-x64.dmg` | كالسابق. |

بصمات SHA-256 لكل الملفات في `SHA256SUMS.txt`.

تنصيب macOS من الطرفية (يثبّت آخر إصدار رسمي):

```bash
curl -fsSL https://raw.githubusercontent.com/sufyanaser/Claude-Adds/main/scripts/install-mac.sh | bash
```

الحزم غير موقّعة بشهادة ناشر: قد يعرض Windows SmartScreen تحذيرًا عند أول تشغيل، وعلى macOS انقر بالزر الأيمن على التطبيق ثم «فتح» عند التنصيب اليدوي.

الإصدارات الموسومة `-dev` بناءات تطويرية آلية لكل تحديث على فرع `develop`، وتتبعها قناة التحديث «تطويرية» داخل التطبيق.

