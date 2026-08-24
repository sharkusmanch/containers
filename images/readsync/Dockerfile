# syntax=docker/dockerfile:1

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.14-slim

FROM python:${PYTHON_VERSION}

# Dependencies ONLY — no application code. readsync's Python is mounted from a
# ConfigMap in home-ops-private, so logic changes are pure GitOps and never
# require rebuilding this image.
#
# An image is needed at all because Audible signs every API request with
# SHA256withRSA (x-adp-alg: SHA256withRSA:1.0), which the stdlib cannot do, and
# CDP needs a WebSocket client.

# renovate: datasource=pypi depName=audible
ARG AUDIBLE_VERSION=0.12.0
# renovate: datasource=pypi depName=websocket-client
ARG WEBSOCKET_CLIENT_VERSION=1.9.0
# renovate: datasource=pypi depName=PyYAML
ARG PYYAML_VERSION=6.0.3

RUN pip install --no-cache-dir \
      "audible==${AUDIBLE_VERSION}" \
      "websocket-client==${WEBSOCKET_CLIENT_VERSION}" \
      "PyYAML==${PYYAML_VERSION}"

USER 65534:65534
ENTRYPOINT ["python"]
