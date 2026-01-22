# Terraform Validation API

A Node.js Express API service that validates Terraform HCL2 code using `terraform validate`.

## Prerequisites

- Node.js (v14 or higher)
- Terraform CLI installed

### Installing Terraform

**macOS (Homebrew):**
```bash
brew install terraform
```

**Linux:**
```bash
# Download from https://www.terraform.io/downloads
# Or use your package manager
```

**Windows:**
Download from [terraform.io/downloads](https://www.terraform.io/downloads)

**Custom Terraform Path:**
If Terraform is installed in a non-standard location, set the `TERRAFORM_PATH` environment variable:
```bash
export TERRAFORM_PATH=/path/to/terraform
```

## Installation

1. Install dependencies:
```bash
npm install
```

2. Ensure Terraform is installed and accessible:
```bash
terraform version
```

## Usage

### Start the server

```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

The server will start on port 3000 by default (or the port specified in the `PORT` environment variable).

### API Endpoints

#### Health Check
```
GET /health
```

Returns:
```json
{
  "status": "ok"
}
```

#### Validate Terraform Code
```
POST /validate
Content-Type: application/json
```

Request body:
```json
{
  "code": "resource \"aws_instance\" \"example\" {\n  ami           = \"ami-12345678\"\n  instance_type = \"t2.micro\"\n}"
}
```

Response (success):
```json
{
  "valid": true,
  "error_count": 0,
  "warning_count": 0,
  "diagnostics": []
}
```

Response (validation errors):
```json
{
  "valid": false,
  "error_count": 1,
  "warning_count": 0,
  "diagnostics": [
    {
      "severity": "error",
      "summary": "Missing required argument",
      "detail": "The argument \"ami\" is required, but no definition was found.",
      "range": {
        "filename": "main.tf",
        "start": {
          "line": 1,
          "column": 1,
          "byte": 0
        },
        "end": {
          "line": 1,
          "column": 1,
          "byte": 0
        }
      }
    }
  ],
  "errors": [
    {
      "summary": "Missing required argument",
      "detail": "The argument \"ami\" is required, but no definition was found.",
      "range": {
        "filename": "main.tf",
        "start": {
          "line": 1,
          "column": 1,
          "byte": 0
        },
        "end": {
          "line": 1,
          "column": 1,
          "byte": 0
        }
      }
    }
  ]
}
```

### Example with curl

```bash
curl -X POST http://localhost:3000/validate \
  -H "Content-Type: application/json" \
  -d '{
    "code": "resource \"aws_instance\" \"example\" {\n  ami           = \"ami-12345678\"\n  instance_type = \"t2.micro\"\n}"
  }'
```

### Example with JavaScript

```javascript
const response = await fetch('http://localhost:3000/validate', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    code: `
      resource "aws_instance" "example" {
        ami           = "ami-12345678"
        instance_type = "t2.micro"
      }
    `
  })
});

const result = await response.json();
console.log(result);
```

## How It Works

1. The API receives HCL2 code in the request body
2. Writes the code to a temporary file
3. Runs `terraform validate -json` in the temporary directory
4. Parses the JSON output from Terraform
5. Returns a structured JSON response with validation results
6. Cleans up the temporary files

## Error Handling

The API handles various error scenarios:
- Missing or invalid input
- Terraform command failures
- File system errors
- JSON parsing errors

All errors are returned with appropriate HTTP status codes and error messages.
