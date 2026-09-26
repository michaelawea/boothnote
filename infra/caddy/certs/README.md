# Cloudflare Origin Certificate 放这里

Cloudflare 后台 → SSL/TLS → Origin Server → Create Certificate，
把两段内容分别存成 origin.pem（证书）和 origin.key（私钥）。

然后 .env 里设：
    TLS_DIRECTIVE=tls /certs/origin.pem /certs/origin.key

Cloudflare 的 SSL/TLS 模式选 Full (strict)。

⚠️ 这两个文件不进 git（见 .gitignore），要单独放到服务器上。
