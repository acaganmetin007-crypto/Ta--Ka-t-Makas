# Taş Kağıt Makas — çevrimiçi

İki kişilik, gerçek zamanlı Taş Kağıt Makas oyunu. Kertenkele-Spock varyantı, rastgele eşleşme ve arkadaşa davet bağlantısı içerir. Herkese açık bir adreste yayınlandığında internetteki herkes birbiriyle eşleşip oynayabilir.

## Nasıl çalışır

Proje iki parçadan oluşur. `server.js` hem sayfayı sunar hem de `/ws` adresinde WebSocket bağlantılarını yönetir. `public/index.html` ise tarayıcıda çalışan oyundur.

Sunucu hakem görevi görür. Hamleler sunucuda tutulur ve iki oyuncu da seçmeden kimseye gönderilmez, bu yüzden tarayıcıda kodu kurcalayarak rakibin hamlesini görmek mümkün değildir. Rastgele eşleşme sırası da sunucuda tutulur. Tek iş parçacığında çalıştığı için aynı anda iki kişinin aynı rakibi kapması gibi yarış durumları oluşmaz.

Oyuncular hesap açmaz. Tarayıcı ilk açılışta rastgele bir kimlik üretip saklar ve oyuncu bir takma ad seçer. Bağlantısı kopan oyuncu iki dakika içinde dönerse oyunu kaldığı yerden sürdürür. Rakip de bu sırada “bağlantısı koptu” uyarısını görür.

## Bilgisayarında çalıştırma

Node.js 18 veya üstü gerekir.

```bash
npm install
npm start
```

Ardından tarayıcıda `http://localhost:3000` adresini aç. Denemek için iki farklı tarayıcı ya da bir normal, bir gizli pencere kullan. Aynı tarayıcının iki sekmesi aynı oyuncu sayılır.

Port değiştirmek için `PORT=8080 npm start` komutunu kullan.

## İnternete açma

Uygulama tek bir Node.js süreci olarak çalışır ve WebSocket destekleyen her platformda yayınlanabilir.

**Render.** Projeyi bir GitHub deposuna yükle. Render’da yeni bir “Web Service” oluştur ve depoyu seç. Build komutu olarak `npm install`, başlatma komutu olarak `npm start` gir. Ücretsiz planda sunucu bir süre kullanılmayınca uykuya geçer ve ilk açılış birkaç saniye sürer.

**Railway veya Fly.io.** Depoyu bağladığında `package.json` dosyasından ayarları kendisi algılar. Ek bir ayar gerekmez.

**Kendi sunucun.** Uygulamayı `pm2` veya `systemd` ile sürekli çalışır hâlde tut. Önüne Nginx koyuyorsan WebSocket yönlendirmesini açman gerekir:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

HTTPS kullanıldığında sayfa otomatik olarak güvenli `wss://` bağlantısına geçer.

## Bilinmesi gerekenler

Tüm oyun durumu bellekte tutulur. Sunucu yeniden başlarsa süren oyunlar sıfırlanır, oyuncular lobiye döner. Bu yüzden uygulama tek bir sunucu örneğiyle çalışacak şekilde tasarlandı. Platformun otomatik ölçeklendirme ayarı varsa örnek sayısını 1’de sabitle. Çok yüksek trafikte birden fazla örnek gerekirse durumun Redis gibi ortak bir depoya taşınması gerekir.

Kötüye kullanıma karşı temel önlemler vardır. Mesaj boyutu ve bağlantı başına mesaj sıklığı sınırlıdır, takma adlar temizlenir, yanıt vermeyen bağlantılar otomatik kapatılır ve iki saat hareketsiz kalan oyunlar silinir.

## Ayarlar

`server.js` dosyasının başındaki sabitlerle oynayabilirsin:

| Sabit | Varsayılan | Anlamı |
|---|---|---|
| `OFFLINE_GRACE_MS` | 2 dakika | Bağlantısı kopan oyuncunun geri dönebileceği süre |
| `GAME_IDLE_MS` | 2 saat | Hareketsiz oyunların silinme süresi |
| `MSG_PER_SEC` | 15 | Bağlantı başına saniyede kabul edilen mesaj sayısı |
