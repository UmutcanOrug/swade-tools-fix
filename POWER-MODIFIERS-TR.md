# Power Modifiers 2.3.0

## Kurulum

Foundry/Forge module Update ile guncelleyin. Sabit manifest:

https://github.com/UmutcanOrug/swade-tools-fix/releases/latest/download/module.json

Dunya yedegi alin ve guncellemeden sonra tum GM/oyuncu istemcilerini yenileyin.
Bu ozellik Experimental Properties ayarindan bagimsizdir.

## Kullanim

1. Karakterin power'ina normal tiklayin. Acilan panelde Power Modifiers'i secin.
2. Blast/Bolt/Burst icin Damage (+2 PP), +1d6 verir. Raise ek zari bundan ayridir.
   Damage Field'in kendi Damage secenegi ise 2d4'u 2d6 yapar.
3. AP, Heavy Weapon, Range, Fatigue, Glow/Shroud, Hinder/Hurry, Lingering Damage
   ve Selective maliyetleri toplamda gorunur. Secimler sadece o kullanimindir;
   pencereyi kapatmak item'i degistirmez. Yerel/native modifier'lar da korunur.
4. Alanli buyulerde Properties -> Enable AoE ve yanindaki ayarlari kullanin.
   Casting alani once yerlestirir. Selective seciliyse etkilenecek hedefleri
   isaretleyip onaylayin. Iptal zar atmaz, PP harcamaz ve template birakmaz.
5. Basarili hedef satirindan normal hasari atin. Secilen Damage/AP/Heavy onceki
   chat kartina baglidir; sonraki item degisiklikleri bunlari kaybettirmez.
   Yaralari eskisi gibi GM uygular. Hasar kartlari tekrar PP harcamaz.

Core power tanimasi SWADE SWID veya Blast/Bolt/Burst/Damage Field adi uzerinden
yapilir. Parantezli Trapping adlari desteklenir. Ozel/yeniden adlandirilmis ve
SWID'siz bir power icin native Power Modifier kullanin; her buyunun hasar
artisinin +1d6 oldugu varsayilmaz.

## Otomatik Etkiler

Aktif birincil GM, ilk hit cozumu sirasinda orijinal sahneyi goruyor olmalidir.
Aktif GM olmadan otomatik hedef modifier'li yeni casting baslatilmaz.

- Fatigue, hedef baska secili modifier ile zaten etkilenmisse hemen eklenir.
  Aksi halde hasarli power'da gercek GM Apply Damage / kalan Soak hasari beklenir.
  Yorgunluk Incapacitated yapacak seviyeye cikarilmaz ve ayni casting tekrarlanmaz.
- Glow/Shroud mevcut Stealth skill'ini ve normal saldiri savunmalarini etkiler.
  Glow gerekli token isigini ekler; sonradan elle degistirilmis isigi ezmez.
- Hinder/Hurry ground Pace'i -2/+2 degistirir; ayni tur bonus/ceza birikmez.
- Lingering, ayni hedef token'in sonraki tur basinda bir defa azaltilmis temel
  hasar atar. Raise/Joker/Conviction tekrar eklenmez. AP/Heavy korunur. GM normal
  hasar kartindan uygular; PP tekrar harcanmaz.
- Instant etkiler hedefin sonraki tur sonunda, sureli etkiler uygun caster tur
  sonunda biter. Combat disinda Foundry World Time kullanilir; gercek zaman
  sayaci yoktur. Ozel surelerde Rounds veya Target's Next Turn secilebilir.
- GM'nin End Power Effects dugmesi yalniz o casting'in yonetilen etkilerini
  kaldirir. Diger buyulerin etkileri/isigi korunur.

Hasarsiz/direnilebilen power'da casting basarisi, hedefin direnisini kaybettigi
anlamina gelmez. Power'in kendi direnisini normal cozumleyip GM kartindaki
Confirm Affected'i kullanin. Sonrasinda modifier etkisi/sure takibi otomatiktir.
Her power'in ana etkisi veya ozel direnis kurali otomatiklestirilmez.

## Sinirlar Ve Geri Donus

Foundry 13 / SWADE 5.x; AoE placement icin Sequencer gerekir. Vehicle uzerindeki
power'larin otomatik hedef etkileri desteklenmez. Lingering icin duz temel zar
formulu gerekir; uyumsuz formuller PP harcanmadan reddedilir. Template geometry,
silah AoE, Evade, Fire ve yaralarin GM tarafindan uygulanmasi korunur.

Eski chat kartlari geriye donuk degistirilmez. 2.2.5'e donmeden once yeni Power
etkilerini End Power Effects veya native Active Effects listesinden bitirin.
Modul ZIP yedegi dunya verisinin yedegi degildir.

701 izole test ve dar/masaustu panel kontrolleri gecti. Canli Foundry/Forge
dunyasina erisilmedi veya veri yazilmadi. Oturumdan once bir test casting'i yapin.
