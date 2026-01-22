#!/bin/bash
# Package Lambda function with psycopg2 for PostgreSQL connectivity

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAMBDA_DIR="${SCRIPT_DIR}/lambda_package"
LAMBDA_ZIP="${SCRIPT_DIR}/lambda_create_db.zip"

echo "Creating Lambda package..."

# Clean up previous build
rm -rf "${LAMBDA_DIR}"
rm -f "${LAMBDA_ZIP}"

# Create package directory
mkdir -p "${LAMBDA_DIR}"

# Copy Lambda function
cp "${SCRIPT_DIR}/lambda_create_db.py" "${LAMBDA_DIR}/index.py"

# Download psycopg2-binary for Lambda (AWS Lambda Python 3.11 compatible)
# Using psycopg2-binary which includes the necessary PostgreSQL libraries
echo "Installing psycopg2-binary..."
pip3 install \
    --target "${LAMBDA_DIR}" \
    --platform manylinux2014_x86_64 \
    --implementation cp \
    --python-version 3.11 \
    --only-binary=:all: \
    --upgrade \
    psycopg2-binary

# Create zip file
echo "Creating zip archive..."
cd "${LAMBDA_DIR}"
zip -r "${LAMBDA_ZIP}" . -q

# Clean up
cd "${SCRIPT_DIR}"
rm -rf "${LAMBDA_DIR}"

echo "Lambda package created: ${LAMBDA_ZIP}"
echo "Size: $(du -h ${LAMBDA_ZIP} | cut -f1)"

