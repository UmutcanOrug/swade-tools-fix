# Properties & Effects — GitHub test sürümü

Bu paket 2.2.0-test.1 test sürümüdür; kararlı Latest sürümü 2.1.20 olarak kalır.
Canlı oyunun ortasında kurmayın. Önce Foundry'den dünyanın ayrıca yedeğini alın
ve mümkünse dünya kopyasında deneyin. Hazırlanan 2.1.20 ZIP yalnız modül
dosyalarının yedeğidir.

## Foundry'den kurulum

Foundry ana ekranında **Add-on Modules → Install Module → Manifest URL** alanına:

`https://github.com/UmutcanOrug/swade-tools-fix/releases/download/v2.2.0-test.1/module.json`

bağlantısını girin. Kararlı sürümün normal Update düğmesi bu test sürümünü seçmez.
Mevcut kurulumun değiştirilmesi gerekiyorsa önce dünya yedeğini ve aşağıdaki
geri dönüş adımlarını hazırlayın. Kurulumdan sonra tüm GM ve oyuncular yeniden yüklesin.

Yerel paketi kurarken Foundry kapalı olsun. Mevcut `modules/swade-tools`
klasörünü ayrı bir yerde saklayın; ZIP içeriğini yeni `modules/swade-tools`
klasörüne açın. `module.json` bu klasörün doğrudan içinde olmalı. Foundry ve
tüm bağlı istemciler yeniden başlatılmalı. Bu test paketi kararlı sürümün
otomatik güncelleme kanalına dağıtılmıyor.

## Açılış

1. Settings → Configure Settings → SWADE Tools → **Experimental Properties & Effects** açın.
2. Aynı yerde **Open Properties Library** kütüphaneyi açar.
3. Silah/Edge/Ability item'ının **Properties** sekmesindeki **Properties & Effects ⚙**
   ile özellik ekleyin. Açık bir item ekranında düğme görünmüyorsa ekranı yeniden açın.
4. **Add Property** kütüphaneden seçer; **Custom** yeni kural oluşturur.
   **Save Properties** onayından önce değişiklikler taslaktır. **Preview / Test**
   gerçek zar atmaz, kaynak harcamaz ve karakteri değiştirmez.

Kütüphanede 40 düzenlenebilir başlangıç şablonu, kategoriler, favoriler ve
Türkçe/İngilizce arama vardır. Şablonu düzenlemek daha önce item'a eklenmiş
kopyaları değiştirmez. Kopyalanan item yeni kimlik aldığı için GM yeniden
onaylamalıdır. Oyuncunun kendi item flag'lerini değiştirmesi kuralları onaylamaz.

## Örnekler

- Özel Dodge: Ability/Edge'e **Dodge-like Ranged Avoidance** ekleyin.
  Değer −2, grup `cover`, stacking **Best**. Daha iyi siperle toplanmaz.
- Zayıflatan silah: **Weakening Hit** → Strength −1 die step, 2 round.
  İsabetten sonra saldırı kartındaki **Effects · More Details → Apply Effects**
  ile yetkili GM uygular. Direnç varsa zar ve sonuç aynı bölümde görünür.
- Yarayla zehir: **Poison Wound** ancak GM hasarı gerçekten uygulayıp kalan
  yara oluştuğunda çalışır. Hasar önizlemesi veya tamamen emilmiş yara yetmez.

Stat düşüşleri temel karakter değerlerinin üzerine yazılmaz; yönetilen native
Active Effect olarak görünür. Süreli efektler native combat süresiyle biter.
**Undo Created Effects** yalnız o uygulamanın oluşturduklarını kaldırır.

## İlk sürümün sınırı

Normal tek atış ve RoF için hazırlanmıştır. Mevcut AoE/Flame, Evade ve yanma
ayarları kendi çalışan sisteminde kalır; yeni özellik tetikleyicileri AoE'ye
bağlanmadı. Araç/operator on-hit efektleri, her resmi Edge'in özel davranışı,
otomatik Edge verme ve serbest kod çalıştırma bu pakette yoktur. Sayısal RoF
sonucuyla çelişen elle seçilmiş Hit/Raise yeni efekt için kabul edilmez.

## Güvenli geri dönüş

1. Bu sürüm hâlâ kurulu iken **Experimental Properties & Effects** ayarını kapatın.
   Yalnız yeni sistemin yönettiği efektler devre dışı kalır; On Fire ve diğer
   modüllerin efektleri korunur.
2. Tüm GM ve oyuncular yeniden yüklesin. Yeni Properties efektlerinin disabled
   olduğunu kontrol edin. Gerekirse yedek klasöründeki GM kapatma makrosunu kullanın.
3. Foundry'yi kapatıp modül dosyalarını 2.1.20 ZIP yedeğiyle geri yükleyin.
   Eski dosyaların üzerine kopyalarken yeni eklenmiş dosyaların kalmaması için
   kurulum klasörünü ayrı bir yerde saklayıp temiz 2.1.20 klasörünü kullanın.
4. Bu işlem dünyadaki diğer değişiklikleri geri almaz. Dünya verilerinde geri
   dönüş gerekiyorsa ayrıca aldığınız Foundry dünya yedeğini kullanın.
