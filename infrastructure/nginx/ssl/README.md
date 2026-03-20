# SSL Certificates

Place your TLS certificate files here:

  fullchain.pem  — Full certificate chain (cert + intermediates)
  privkey.pem    — Private key

## Using Let's Encrypt (free, recommended)

```bash
sudo apt-get install -y certbot
sudo certbot certonly --standalone -d yourdomain.com -d api.yourdomain.com

sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem ./fullchain.pem
sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem   ./privkey.pem
sudo chmod 644 fullchain.pem privkey.pem
```

Then restart nginx: bash restart.sh nginx

## Without SSL (dev/testing only)
The platform works on HTTP without these files.
nginx will serve on port 80 only.
