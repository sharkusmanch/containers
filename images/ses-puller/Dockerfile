# syntax=docker/dockerfile:1

# renovate: datasource=docker depName=python versioning=docker
ARG PYTHON_VERSION=3.13-slim

FROM python:${PYTHON_VERSION}

# ses-puller: SES/S3 spool -> Stalwart injection daemon.
# Design: Outline doc En1hODwyWH (emailctl v3 Puller Design v1.1).
# Unlike readsync, the application code is BAKED IN (not ConfigMap-mounted):
# this is security-sensitive mail-authentication logic behind a signed +
# attested image, and the cluster's Kyverno policy verifies that provenance —
# so the code that runs must be the code that was attested.

# renovate: datasource=pypi depName=boto3
ARG BOTO3_VERSION=1.43.85
# renovate: datasource=pypi depName=prometheus-client
ARG PROMETHEUS_CLIENT_VERSION=0.26.0
# renovate: datasource=pypi depName=dnspython
ARG DNSPYTHON_VERSION=2.8.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends gnupg \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir \
         "boto3==${BOTO3_VERSION}" \
         "prometheus-client==${PROMETHEUS_CLIENT_VERSION}" \
         "dnspython==${DNSPYTHON_VERSION}"

COPY app/ /app/
WORKDIR /app

# Non-root; GNUPGHOME is an emptyDir at /tmp/gnupg (0700, created at startup).
USER 1000:1000
ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["python", "puller.py"]
