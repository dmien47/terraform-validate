const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

// Find terraform executable
function findTerraform() {
  // Check if terraform path is provided via environment variable
  if (process.env.TERRAFORM_PATH) {
    if (fs.existsSync(process.env.TERRAFORM_PATH)) {
      return process.env.TERRAFORM_PATH;
    }
  }

  // Common terraform installation paths
  const commonPaths = [
    'terraform', // Try PATH first
    '/opt/homebrew/bin/terraform', // Homebrew on Apple Silicon
    '/usr/local/bin/terraform', // Homebrew on Intel Mac / Linux
    '/usr/bin/terraform', // System installation
    path.join(os.homedir(), '.local/bin/terraform'), // User local
  ];

  for (const terraformPath of commonPaths) {
    try {
      // Check if file exists and is executable
      if (fs.existsSync(terraformPath)) {
        return terraformPath;
      }
    } catch (e) {
      // Continue searching
    }
  }

  return null;
}

const TERRAFORM_CMD = findTerraform();

if (!TERRAFORM_CMD) {
  console.error('ERROR: Terraform executable not found!');
  console.error('Please install Terraform or set TERRAFORM_PATH environment variable.');
  console.error('Common installation methods:');
  console.error('  - macOS: brew install terraform');
  console.error('  - Or set: export TERRAFORM_PATH=/path/to/terraform');
  process.exit(1);
}

console.log(`Using Terraform at: ${TERRAFORM_CMD}`);

// CORS middleware - allow requests from any origin
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

// Middleware to parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Terraform validate endpoint
app.post('/validate', async (req, res) => {
  const { code } = req.body;

  // Validate input
  if (!code || typeof code !== 'string') {
    return res.status(400).json({
      valid: false,
      error: 'Missing or invalid "code" field in request body. Expected a string containing HCL2 code.'
    });
  }

  // Create temporary directory and file
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terraform-validate-'));
  const tempFile = path.join(tempDir, 'main.tf');

  try {
    // Write HCL2 code to temporary file
    fs.writeFileSync(tempFile, code, 'utf8');

    try {
      // Initialize Terraform (required before validate)
      // Use -backend=false to skip backend initialization for faster validation
      await execAsync(`${TERRAFORM_CMD} init -backend=false -input=false`, { 
        cwd: tempDir,
        timeout: 30000 // 30 second timeout for init
      });
    } catch (initError) {
      // If init fails, we can still try validate for basic syntax checking
      // Some validation errors might be about missing providers, but that's still useful
      console.warn('Terraform init failed, proceeding with validate:', initError.message);
    }

    // Run terraform validate
    // Note: terraform validate exits 1 on validation failure but still outputs JSON to stdout
    let stdout = '';
    try {
      const result = await execAsync(`${TERRAFORM_CMD} validate -json`, {
        cwd: tempDir,
        timeout: 10000 // 10 second timeout for validate
      });
      stdout = result.stdout;
    } catch (validateError) {
      // Exit code 1 = validation failed; Terraform still prints JSON to stdout
      stdout = validateError.stdout || '';
      const stderr = validateError.stderr || validateError.message || '';

      // If we got no stdout, treat as real command failure
      if (!stdout.trim()) {
        if (stderr.includes('command not found') || stderr.includes('terraform: not found')) {
          return res.status(500).json({
            valid: false,
            error: 'Terraform executable not found',
            details: 'Terraform is not installed or not in PATH. Please install Terraform or set TERRAFORM_PATH environment variable.'
          });
        }
        return res.status(500).json({
          valid: false,
          error: 'Terraform validate command failed',
          details: stderr
        });
      }
    }

    // Parse terraform validate JSON output (from success or from stdout on exit 1)
    let validationResult;
    try {
      validationResult = JSON.parse(stdout);
    } catch (parseError) {
      return res.status(500).json({
        valid: false,
        error: 'Failed to parse terraform output',
        details: parseError.message
      });
    }

    // Check if validation passed
    const isValid = validationResult.valid === true;

    // Build response
    const response = {
      valid: isValid,
      error_count: validationResult.error_count || 0,
      warning_count: validationResult.warning_count || 0,
      diagnostics: validationResult.diagnostics || []
    };

    // If there are errors, include formatted error messages
    if (!isValid && validationResult.diagnostics) {
      response.errors = validationResult.diagnostics
        .filter(d => d.severity === 'error')
        .map(d => ({
          summary: d.summary,
          detail: d.detail,
          range: d.range
        }));
    }

    // Return appropriate status code
    const statusCode = isValid ? 200 : 400;
    res.status(statusCode).json(response);

  } catch (writeError) {
    res.status(500).json({
      valid: false,
      error: 'Failed to write temporary file',
      details: writeError.message
    });
  } finally {
    // Clean up temporary directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error('Failed to clean up temp directory:', cleanupError);
    }
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    valid: false,
    error: 'Internal server error',
    details: err.message
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Terraform validation API server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Validate endpoint: http://localhost:${PORT}/validate`);
});
