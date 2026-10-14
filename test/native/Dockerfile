# Isolated Linux service test. Production native installation does not use Docker.
FROM node:24-alpine
RUN apk add --no-cache python3 nginx openrc util-linux
WORKDIR /source
COPY package.json README.md ./
COPY src ./src
COPY public ./public
COPY scripts/install-linux.py ./scripts/install-linux.py
COPY test/native_test.py ./test/native_test.py
COPY test/native/e2e.py ./test/native/e2e.py
CMD ["python3", "test/native/e2e.py"]
