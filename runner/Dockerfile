# SDVsolution build runner image.
# Build from the REPOSITORY ROOT (the runner imports the shared generator in src/lib):
#   docker build -f runner/Dockerfile -t sdv-runner .
# Run (managed fleet or customer infrastructure — only the token differs):
#   docker run --rm -e SDV_API=https://app.sdvsolution.com -e SDV_RUNNER_TOKEN=sdvr_... sdv-runner
#
# NOTE: pin the base image by digest in production (node:22-bookworm-slim@sha256:...) so a build records
# exactly which toolchain produced it. Not built or tested in the authoring environment (no Docker there).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev make \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src/lib ./src/lib
COPY runner ./runner

# Run unprivileged; each job works in its own temp directory and is deleted afterwards.
RUN useradd --create-home --uid 10001 runner
USER runner

ENV CC=gcc
CMD ["node", "runner/runner.mjs"]
