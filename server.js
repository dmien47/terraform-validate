// Import required modules first
const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");
const { exec } = require("child_process");
const { promisify } = require("util");

// Set up Terraform plugin cache directory for faster init (shared across requests)
const PLUGIN_CACHE_DIR = process.env.TF_PLUGIN_CACHE_DIR || "/tmp/terraform-plugin-cache";
process.env.TF_PLUGIN_CACHE_DIR = PLUGIN_CACHE_DIR;

// Ensure plugin cache directory exists
if (!fs.existsSync(PLUGIN_CACHE_DIR)) {
  fs.mkdirSync(PLUGIN_CACHE_DIR, { recursive: true });
  console.log(`Created Terraform plugin cache directory: ${PLUGIN_CACHE_DIR}`);
} else {
  console.log(`Using Terraform plugin cache directory: ${PLUGIN_CACHE_DIR}`);
}

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
    "terraform", // Try PATH first
    "/opt/homebrew/bin/terraform", // Homebrew on Apple Silicon
    "/usr/local/bin/terraform", // Homebrew on Intel Mac / Linux
    "/usr/bin/terraform", // System installation
    path.join(os.homedir(), ".local/bin/terraform"), // User local
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
  console.error("ERROR: Terraform executable not found!");
  console.error(
    "Please install Terraform or set TERRAFORM_PATH environment variable.",
  );
  console.error("Common installation methods:");
  console.error("  - macOS: brew install terraform");
  console.error("  - Or set: export TERRAFORM_PATH=/path/to/terraform");
  process.exit(1);
}

console.log(`Using Terraform at: ${TERRAFORM_CMD}`);

// CORS middleware - allow requests from any origin
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

// Middleware to parse JSON bodies
app.use(express.json({ limit: "10mb" }));

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Terraform validate endpoint
app.post("/validate", async (req, res) => {
  const { code } = req.body;

  // Validate input
  if (!code || typeof code !== "string") {
    return res.status(400).json({
      valid: false,
      error:
        'Missing or invalid "code" field in request body. Expected a string containing HCL2 code.',
    });
  }

  // Create temporary directory and file
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "terraform-validate-"));
  const tempFile = path.join(tempDir, "main.tf");

  try {
    // Write HCL2 code to temporary file
    fs.writeFileSync(tempFile, code, "utf8");

    // Try validate first without init for fast path (works for basic syntax checking)
    // Only run init if validate fails due to missing providers/initialization
    let stdout = "";
    let needsInit = false;

    try {
      const result = await execAsync(`${TERRAFORM_CMD} validate -json`, {
        cwd: tempDir,
        timeout: 3000, // 3 second timeout for validate (should be fast)
      });
      stdout = result.stdout;
    } catch (validateError) {
      // Exit code 1 = validation failed; Terraform still prints JSON to stdout
      stdout = validateError.stdout || "";
      const stderr = validateError.stderr || validateError.message || "";

      // Check if we need to initialize (provider/initialization errors)
      // Only trigger init if we get explicit init-related errors, not generic failures
      const requiresInit =
        stderr.includes("initialization required") ||
        stderr.includes("provider requirements") ||
        stderr.includes("terraform init") ||
        stderr.includes("Could not satisfy plugin requirements") ||
        stderr.includes("Error: Missing required provider") ||
        stderr.includes("Error: Provider requirements");

      // Also check JSON diagnostics for init-related errors
      if (stdout.trim() && !requiresInit) {
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.diagnostics) {
            const hasInitError = parsed.diagnostics.some(
              (d) =>
                d.summary &&
                (d.summary.includes("initialization required") ||
                  d.summary.includes("provider requirements") ||
                  d.summary.includes("terraform init") ||
                  d.summary.includes("plugin requirements"))
            );
            if (hasInitError) {
              requiresInit = true;
            }
          }
        } catch (e) {
          // If JSON parse fails, check stdout text
          if (stdout.includes("terraform init") || stdout.includes("initialization")) {
            requiresInit = true;
          }
        }
      }

      if (requiresInit) {
        needsInit = true;
      } else if (!stdout.trim()) {
        // Real command failure
        if (
          stderr.includes("command not found") ||
          stderr.includes("terraform: not found")
        ) {
          return res.status(500).json({
            valid: false,
            error: "Terraform executable not found",
            details:
              "Terraform is not installed or not in PATH. Please install Terraform or set TERRAFORM_PATH environment variable.",
          });
        }
        return res.status(500).json({
          valid: false,
          error: "Terraform validate command failed",
          details: stderr,
        });
      }
    }

    // If validation failed due to missing init, run init and retry
    if (needsInit) {
      try {
        // Initialize Terraform (required for provider-based validation)
        // Flags to optimize init with cached providers:
        // -backend=false: Skip backend initialization
        // -input=false: Skip interactive prompts
        // -upgrade=false: Don't upgrade providers (use cached versions)
        // -reconfigure: Force reconfiguration (needed for new temp dirs)
        // Plugin cache will be used automatically via TF_PLUGIN_CACHE_DIR
        await execAsync(
          `${TERRAFORM_CMD} init -backend=false -input=false -upgrade=false -reconfigure`,
          {
            cwd: tempDir,
            timeout: 30000, // 30 second timeout for init
          }
        );
      } catch (initError) {
        // If init fails, we can still try validate for basic syntax checking
        console.warn(
          "Terraform init failed, proceeding with validate:",
          initError.message,
        );
      }

      // Retry validate after init
      try {
        const result = await execAsync(`${TERRAFORM_CMD} validate -json`, {
          cwd: tempDir,
          timeout: 3000, // 3 second timeout for validate
        });
        stdout = result.stdout;
      } catch (validateError) {
        // Exit code 1 = validation failed; Terraform still prints JSON to stdout
        stdout = validateError.stdout || "";
        const stderr = validateError.stderr || validateError.message || "";

        // If we got no stdout, treat as real command failure
        if (!stdout.trim()) {
          return res.status(500).json({
            valid: false,
            error: "Terraform validate command failed",
            details: stderr,
          });
        }
      }
    }

    // Parse terraform validate JSON output (from success or from stdout on exit 1)
    let validationResult;
    try {
      validationResult = JSON.parse(stdout);
    } catch (parseError) {
      return res.status(500).json({
        valid: false,
        error: "Failed to parse terraform output",
        details: parseError.message,
      });
    }

    // Check if validation passed
    const isValid = validationResult.valid === true;

    // Build response
    const response = {
      valid: isValid,
      error_count: validationResult.error_count || 0,
      warning_count: validationResult.warning_count || 0,
      diagnostics: validationResult.diagnostics || [],
    };

    // If there are errors, include formatted error messages
    if (!isValid && validationResult.diagnostics) {
      response.errors = validationResult.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => ({
          summary: d.summary,
          detail: d.detail,
          range: d.range,
        }));
    }

    // Return appropriate status code
    const statusCode = isValid ? 200 : 400;
    res.status(statusCode).json(response);
  } catch (writeError) {
    res.status(500).json({
      valid: false,
      error: "Failed to write temporary file",
      details: writeError.message,
    });
  } finally {
    // Clean up temporary directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error("Failed to clean up temp directory:", cleanupError);
    }
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(500).json({
    valid: false,
    error: "Internal server error",
    details: err.message,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Terraform validation API server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Validate endpoint: http://localhost:${PORT}/validate`);
});
