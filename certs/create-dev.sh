#!/bin/bash

# Create directories for CA and certificates
mkdir -p ca/root-ca
cd ca/root-ca

# Generate root CA private key
openssl genrsa -out root-ca.key 4096

# Generate root CA certificate
openssl req -x509 -new -nodes -key root-ca.key -sha256 -days 3650 -out root-ca.crt -subj "/C=US/ST=State/L=City/O=Development CA/CN=Local Development Root CA"

# Create directory for localhost certificate
mkdir -p ../localhost
cd ../localhost

# Generate localhost private key
openssl genrsa -out localhost.key 2048

# Create certificate signing request (CSR) configuration
cat > localhost.conf << EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext

[dn]
C = H1
ST = State
L = City
O = Development
CN = localhost

[req_ext]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = *.localhost
IP.1 = 127.0.0.1
IP.2 = ::1
EOF

# Generate CSR using the configuration
openssl req -new -key localhost.key -out localhost.csr -config localhost.conf

# Create certificate extension configuration
cat > localhost.ext << EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = *.localhost
IP.1 = 127.0.0.1
IP.2 = ::1
EOF

# Generate localhost certificate signed by our CA
openssl x509 -req -in localhost.csr \
    -CA ../root-ca/root-ca.crt \
    -CAkey ../root-ca/root-ca.key \
    -CAcreateserial \
    -out localhost.crt \
    -days 365 \
    -sha256 \
    -extfile localhost.ext

echo "Certificates created successfully!"
echo "Root CA: $(pwd)/../root-ca/root-ca.crt"
echo "Localhost cert: $(pwd)/localhost.crt"
echo "Localhost key: $(pwd)/localhost.key"
