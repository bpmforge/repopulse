FROM ubuntu:latest
WORKDIR app
RUN apt-get update && apt-get install -y curl
ADD app.tar.gz /srv/
RUN cd /srv && make
USER root
CMD ["/srv/app"]
