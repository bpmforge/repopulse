== 2026-09-11T05:23:03Z README-literal install smoke, host Darwin arm64, podman podman version 6.1.0
== 1 shasum
repopulse-0.1.0-rc1-linux-arm64.tar.gz: OK
== 2 extract
REPOPULSE_VERSION=0.1.0-rc1
REPOPULSE_IMAGE_PREFIX=localhost/repopulse
PLATFORM=linux/arm64
GIT_SHA=d3b85bc01a3621e2bdc3ebb3d3fae2cd7d04c11b
GIT_DIRTY=true
BUILT_AT=2026-09-10T23:41:22Z
== 3 install (disposable project rp-doc, port 8299)
RepoPulse 0.1.0-rc1 (linux/arm64), built from d3b85bc01a3621e2bdc3ebb3d3fae2cd7d04c11b
== verifying checksums
runtime: podman (podman version 6.1.0)
== loading images (this reads 1.8G; a minute or two)
Loaded image: localhost/repopulse/migrate:0.1.0-rc1
Loaded image: localhost/repopulse/api:0.1.0-rc1
Loaded image: localhost/repopulse/worker:0.1.0-rc1
Loaded image: localhost/repopulse/scan-runner:0.1.0-rc1
Loaded image: localhost/repopulse/web:0.1.0-rc1
Loaded image: localhost/repopulse/scan:0.1.0-rc1
Loaded image: docker.io/library/postgres:16
Loaded image: docker.io/library/redis:7-alpine
images:  6 loaded as localhost/repopulse/<name>:0.1.0-rc1
== writing deploy/.env

[32mWrote deploy/.env[0m [2m(mode 0600)[0m

  URL:   http://localhost:8299
  Port:  127.0.0.1:8299
  Admin: doc@example.com

  Generated: POSTGRES_PASSWORD, REDIS_PASSWORD, SESSION_SECRET,
             TOKEN_ENC_KEY, WEBHOOK_SECRET [2m(values not printed)[0m

  [31mBACK UP TOKEN_ENC_KEY SEPARATELY FROM YOUR DATABASE DUMP.[0m
  It decrypts stored forge credentials. A database restored without
  it cannot use any connection it contains.

  Next:  deploy/up.sh

== starting
WARNING: CONTAINER_SOCKET=/run/user/501/podman/podman.sock is not a socket on this machine.
         scan-runner needs the podman API socket. Enable it with
           systemctl --user enable --now podman.socket   # rootless
           sudo systemctl enable --now podman.socket     # root
         (under podman machine on macOS the path is the VM's; ignore this).
runtime:    podman (compose project: rp-doc)
scan-runner: podman via /run/user/501/podman/podman.sock, listening on the internal scan network
scan rules: /Users/bmatthews/tmp/rp-doc-smoke/repopulse-0.1.0-rc1-linux-arm64/deploy/scan-rules
images:     localhost/repopulse/*:0.1.0-rc1 (all present)
[4m>>>> Executing external compose provider "/opt/homebrew/bin/podman-compose". Please see podman-compose(1) for how to disable this message. <<<<

[0m9a56851f1a97e0586f85f8d7f7652e65cb589b2409d965c5d6e275dfc2551907
43064e70a75c153a0ea5abed66b08e2981b7b43088bd59fb4b9f1a20ae4b62b0
63a6bf1507db24eb4385dc94a07c958522b05a10c82b7bb2352a31fd0b1fedc2
5bf2c3feac11d4e28c7c9ef85a748b5e4f62910c447d10a1cc580c8cd7fc3a0d
02a907e39551cf3817bf05350f8a156a068d1e1dbc22e010c44017e26faf7f37
69716632555b4d6a557ecdb76d5ff6df8048a89921b3d60afd081b21915d4563
685a5b42bd988315992b42decde3bbcce5b5a7a3256ad748bd6999cfde73b627
873fb2d9bcf0815ab2d917f6f367eb2fbe99e0384fe552c61fa7cb1cc5993b0c
e5c8be34fde72b009edf80627b4072a5bd8a88226e82c642f99c243471fe37d6
cdb2ed4beda370d27ad4fd18ea1d74ea038570850d19d03eca63cfb26682e7ab
rp-doc_postgres_1
rp-doc_redis_1
rp-doc_scan-runner_1
rp-doc_migrate_1
rp-doc_api_1
rp-doc_worker_1
rp-doc_web_1

All services running. Open http://localhost:8099
== INSTALL EXIT 0
== 4 healthz
healthz 200
root 200
me/context 401
== 5 login
{"type":"about:blank","title":"Missing or invalid X-Requested-With header","status":403,"instance":"/auth/local/login","request_id":"req-4"} login 403
== 6 containers
rp-doc_postgres_1 Up 12 seconds (healthy)
rp-doc_redis_1 Up 12 seconds (healthy)
rp-doc_scan-runner_1 Up 12 seconds
rp-doc_api_1 Up 5 seconds
rp-doc_worker_1 Up 5 seconds
rp-doc_web_1 Up 4 seconds
== 2026-09-11T05:23:26Z done
{"type":"about:blank","title":"Missing or invalid X-Requested-With header","status":403,"instance":"/auth/local/login","request_id":"req-5"} login 403
== 5b login with X-Requested-With: repopulse
{"must_change_password":true} login 200
== 7 teardown
63a6bf1507db24eb4385dc94a07c958522b05a10c82b7bb2352a31fd0b1fedc2
rp-doc_default
rp-doc_scan
       0
0
== 2026-09-11T05:26:07Z torn down
