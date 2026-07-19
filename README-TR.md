# SWADE Tools Fix — Türkçe kullanım notları

Bu geliştirme dalı Foundry VTT 13.351 ve SWADE 5.1.x için hazırlanmıştır.
SWADE'nin kendi karakter sayfası varsayılan olarak korunur. Modül, mevcut
düğmeleri değiştirmek yerine eşya satırlarına ayrı SWADE Tools düğmeleri ekler.

## RoF ve mühimmat

SWADE Tools saldırı penceresi, silahın RoF değerine göre kullanılabilir atış
modlarını gösterir:

| RoF | Standart mermi tüketimi |
| --- | ---: |
| 1 | 1 |
| 2 | 5 |
| 3 | 10 |
| 4 | 20 |
| 5 | 40 |
| 6 | 50 |

Ek action üzerinde `Resources Used` tanımlanmışsa bu özel değer kullanılır.
Standart tablonun üzerindeki RoF değerleri için action üzerinde tüketim miktarı
açıkça belirtilmelidir. Zar atılmadan önce cephane kontrol edilir; yeterli
cephane yoksa zar başlamaz. Tüketim ve reload işlemleri SWADE'nin kendi
`canExpendResources`, `consume` ve `reload` işlevleri üzerinden yapılır.

Mermi önce yalnız doğrulanır; zar gerçekten oluşturulduktan sonra tek kez
tüketilir. Böylece iptal edilen veya oluşturulamayan zar mermi harcamaz.

**Yerel RoF actionlarında standart mermi maliyetini kullan** ayarı varsayılan
olarak açıktır. Native bir weapon action'ı RoF 2–6 olduğu hâlde hâlâ varsayılan
`Resources Used: 1` değerindeyse modül zar öncesinde bunu sırasıyla
`5/10/20/40/50` olarak düzeltir. Bilerek özel maliyet verdiğiniz action'larda
bu değer korunur.

Nişangâh düğmesindeki saldırı penceresinde cover, aydınlatma ve çoklu action
seçicileri doğrudan görünür. Cover için Light `-2`, Medium `-4`, Heavy `-6`
ve Total `-8` değerleri elle seçilebilir.

Şarjör veya mermi olarak kullandığınız Consumable/Gear eşyasını açıp
**Otomasyon → Yüklü mühimmat hasarı** bölümünü etkinleştirebilirsiniz. `+2`
veya `+1d6x` gibi bir hasar modifierı girildiğinde bu değer yalnız o mühimmat
gerçekten silaha yüklüyken uygulanır. Magazine/Battery için SWADE'nin
`loadedAmmo` kaydı, gevşek mühimmat için silahın seçili ammo eşyası kullanılır.
Hasar daha sonra atılsa bile saldırı anındaki mühimmat profili hatırlanır;
arada yapılan reload o saldırının hasarını değiştirmez.

## Eşya otomasyon penceresi

Bir Weapon, Power, Action, Gear, Consumable, Edge, Hindrance veya Ability
eşyasını düzenleyin. Pencerenin üst kısmındaki **Otomasyon** düğmesi SWADE Tools
ayarlarını açar.

Çözüm türleri:

- **Yerel SWADE:** Ek otomasyon yapmaz.
- **Şablon ve hedef seçimi:** Şablon içindeki tokenları seçer fakat zar atmaz.
- **Alan savunması/evasion:** Her hedefe seçilen beceri veya özellik zarını
  attırır. Yalnız başarısız hedeflere ortak hasar zarı açabilir.
- **Karşılıklı zar:** Kaynak item'ın zarı sonrasında seçili her hedefe savunma
  zarı attırır ve sonuçları karşılaştırır.
- **El bombası:** Atış noktasına olan menzili hesaplar, item'da tanımlı
  Athletics veya başka bir activation action'ını kullanır, bombayı bir kez
  tüketir ve patlama hedeflerini çözer.

Şablonu bulunan fakat özel profil verilmemiş eşyalar güvenli varsayılan olarak
yalnız **şablon ve hedef seçimi** kullanır. Her şablona otomatik Athletics veya
hasar uygulanmaz.

Alan savunması ve karşılıklı zar için savunma trait'i serbestçe seçilebilir:
Athletics, Spirit, Vigor, Agility veya aktördeki başka bir Skill olabilir.
Oyuncu sahibi olmadığı bir NPC'ye saldırıyorsa savunma isteği aktif GM'ye
gönderilir ve zar GM tarafında üretilir. Aktif GM yoksa işlem sahte bir sonuç
üretmek yerine durur.

Power profillerinde **Güç Puanlarını otomatik harca** açıksa seçili arcane
havuzu kullanılır. Başarılı aktivasyonda tam maliyet, başarısız aktivasyonda
1 PP harcanır. **No Power Points** Setting Rule açıksa PP harcanmaz; güç
maliyetinden doğan aktivasyon cezası zar modifierı olarak eklenir.

Alan profillerini çalıştırırken karakter sayfasındaki sihirli değnek düğmesini
kullanın. Normal SWADE template düğmesi aktivasyon zarını atlamaz; güvenlik
için yalnız template yerleştirip hedef seçer.

## El bombası

En temiz kurulum, el bombasını bir Weapon olarak tanımlamaktır:

- Trait: Athletics
- Range: örneğin `5/10/20`
- Damage ve AP
- Small, Medium veya Large template
- Tek kullanımlık silah/şarjör ayarları

Bombayı ayrı Consumable ve saldırı profili olarak tutuyorsanız Otomasyon
penceresinde:

- **Hasar kaynağı eşya**
- **Tüketilecek eşya veya silah**

alanlarını seçin. Modül eşya adına bakarak başka bir bomba tahmin etmez.
Yanındaki miktar alanı her kullanımda kaç adet veya charge tüketileceğini
belirler.

Başarısız atışta şablon kırmızı olur. SWADE sapma sonucunu uygulayıp şablonu
taşıdıktan sonra chat kartındaki **Şablon konumunu onayla ve hasarı çöz**
düğmesini kullanın. Sequencer veya JB2A zorunlu değildir.
Bu son onay, aynı düğmeye birden fazla kullanıcı bassa bile sahneyi görüntüleyen
tek bir aktif GM üzerinden yürütülür.

## Dodge benzeri Edge kuralları

İlgili Edge, Hindrance veya Ability eşyasını açıp **Otomasyon** düğmesine basın.
Örneğin Dodge benzeri bir kural:

- Kural etkin: Evet
- Rol: Savunan
- Saldırı türü: Menzilli
- Modifier: `-2`
- Grup: Cover
- Biçim: En güçlüyü kullan

Bu kural isim karşılaştırmasına bağlı değildir. Eşya SWADE tarafından zaten
`dodge` SWID ile tanınıyorsa yerel modifier kaldırılıp ayarladığınız değer
kullanılır; fiziksel cover ile iki kez toplanmaz.

## Native sayfa

**SWADE'nin kendi karakter sayfasını koru** ayarı varsayılan olarak açıktır.
Normal item adı, resim, zar, reload ve chat-card düğmeleri SWADE tarafından
işlenmeye devam eder. Nişangâh düğmesi eski SWADE Tools saldırı penceresini,
sihirli değnek düğmesi ise item için kaydedilmiş çözüm profilini açar. Son
kullanılan silahın satırında saat/geri dönüş düğmesi belirir; mevcut hedefler
varsa onları, yoksa aynı sahnedeki önceki hedefleri kullanarak saldırıyı
tekrarlar.

## Beta doğrulama notu

Bu paket Foundry VTT 13.351 ve SWADE 5.1.1 kaynak koduna göre statik olarak
doğrulandı ve otomatik servis testlerinden geçirildi. Gridless/hex, elevation,
vehicle gunner ve birden fazla GM'nin aynı anda aynı chat düğmesine basması gibi
uç senaryolar gerçek bir Foundry dünyasında ayrıca denenmelidir.
