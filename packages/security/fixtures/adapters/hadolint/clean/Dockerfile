FROM ubuntu:24.04
WORKDIR /srv
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl=8.5.0-2ubuntu10.6 \
 && rm -rf /var/lib/apt/lists/*
COPY app.tar.gz /srv/
USER 65534:65534
HEALTHCHECK CMD ["/srv/app", "--health"]
CMD ["/srv/app"]
