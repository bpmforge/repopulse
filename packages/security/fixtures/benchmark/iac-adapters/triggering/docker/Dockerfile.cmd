FROM debian:12.5
RUN useradd -m app
USER app
# expect: tool.hadolint.DL3025
CMD python app.py
