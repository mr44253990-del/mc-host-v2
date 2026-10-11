'use strict';
// Multi-file worker support system
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const extract = require('extract-zip');
const { genId } = require('./util');

// Supported file types and their max sizes
const FILE_TYPES = {
  '.js': { type: 'script', maxSize: 1048576, category: 'code' },
  '.mjs': { type: 'script', maxSize: 1048576, category: 'code' },
  '.cjs': { type: 'script', maxSize: 1048576, category: 'code' },
  '.json': { type: 'config', maxSize: 524288, category: 'config' },
  '.yaml': { type: 'config', maxSize: 524288, category: 'config' },
  '.yml': { type: 'config', maxSize: 524288, category: 'config' },
  '.env': { type: 'env', maxSize: 52428, category: 'env' },
  '.txt': { type: 'text', maxSize: 209715, category: 'text' },
  '.md': { type: 'markdown', maxSize: 209715, category: 'text' },
  '.csv': { type: 'data', maxSize: 1048576, category: 'data' },
  '.xml': { type: 'data', maxSize: 1048576, category: 'data' },
  '.png': { type: 'image', maxSize: 2097152, category: 'asset' },
  '.jpg': { type: 'image', maxSize: 2097152, category: 'asset' },
  '.jpeg': { type: 'image', maxSize: 2097152, category: 'asset' },
  '.gif': { type: 'image', maxSize: 2097152, category: 'asset' },
  '.svg': { type: 'image', maxSize: 1048576, category: 'asset' },
  '.zip': { type: 'archive', maxSize: 5242880, category: 'archive' }
};

// Default file structure for workers
const DEFAULT_STRUCTURE = {
  'index.js': `// Main worker entry point
export default {
  async fetch(request, env, ctx) {
    return new Response('Hello from worker!', { status: 200 });
  },
  async scheduled(event, env, ctx) {
    // Scheduled task handler
  }
};`,
  'config.json': `{
  "name": "My Worker",
  "version": "1.0.0",
  "description": "A custom Cloudflare Worker"
}`,
  '.env.example': `# Worker environment variables
# Copy this to .env and fill in your values
API_KEY=your_api_key_here
DEBUG=false`
};

class WorkerFiles {
  constructor(store, workers) {
    this.store = store;
    this.workers = workers;
    this.baseDir = path.join(store.dir, 'worker-files');
    
    // Ensure directories exist
    fs.mkdirSync(this.baseDir, { recursive: true });
    
    // Initialize file metadata for all workers
    this._initMetadata();
  }

  _initMetadata() {
    const workers = this.store.data.workers || [];
    for (const worker of workers) {
      this._ensureWorkerDir(worker.id);
      this._ensureMetadata(worker.id);
    }
  }

  _ensureWorkerDir(workerId) {
    const workerDir = this._getWorkerDir(workerId);
    if (!fs.existsSync(workerDir)) {
      fs.mkdirSync(workerDir, { recursive: true });
    }
  }

  _ensureMetadata(workerId) {
    const metaPath = this._getMetaPath(workerId);
    if (!fs.existsSync(metaPath)) {
      const metadata = {
        id: workerId,
        version: '1.0.0',
        files: {},
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    }
  }

  _getWorkerDir(workerId) {
    return path.join(this.baseDir, workerId);
  }

  _getMetaPath(workerId) {
    return path.join(this._getWorkerDir(workerId), '.worker-meta.json');
  }

  _getFilePath(workerId, filePath) {
    // Sanitize file path to prevent directory traversal
    const sanitized = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
    return path.join(this._getWorkerDir(workerId), sanitized);
  }

  _getRelativePath(workerId, fullPath) {
    const workerDir = this._getWorkerDir(workerId);
    return path.relative(workerDir, fullPath);
  }

  getMetadata(workerId) {
    try {
      const metaPath = this._getMetaPath(workerId);
      if (fs.existsSync(metaPath)) {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      }
    } catch (e) {
      console.error('[WorkerFiles] Error reading metadata:', e.message);
    }
    return null;
  }

  updateMetadata(workerId, updates) {
    const metaPath = this._getMetaPath(workerId);
    let metadata = { files: {}, createdAt: Date.now(), updatedAt: Date.now() };
    
    if (fs.existsSync(metaPath)) {
      try {
        metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (e) {
        console.error('[WorkerFiles] Error reading existing metadata:', e.message);
      }
    }
    
    metadata = { ...metadata, ...updates, updatedAt: Date.now() };
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    return metadata;
  }

  // List all files for a worker
  list(workerId) {
    const workerDir = this._getWorkerDir(workerId);
    if (!fs.existsSync(workerDir)) {
      return { files: [], directories: [] };
    }

    const files = [];
    const directories = [];
    
    const traverse = (dir, relativePath = '') => {
      const items = fs.readdirSync(dir);
      
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const itemRelativePath = relativePath ? path.join(relativePath, item) : item;
        
        const stats = fs.statSync(fullPath);
        
        if (stats.isDirectory()) {
          directories.push({
            name: item,
            path: itemRelativePath,
            size: 0,
            type: 'directory',
            createdAt: stats.birthtimeMs || stats.mtimeMs,
            updatedAt: stats.mtimeMs
          });
          traverse(fullPath, itemRelativePath);
        } else if (stats.isFile()) {
          const ext = path.extname(item).toLowerCase();
          const fileInfo = FILE_TYPES[ext] || { type: 'unknown', maxSize: 1048576, category: 'other' };
          
          files.push({
            name: item,
            path: itemRelativePath,
            size: stats.size,
            type: fileInfo.type,
            category: fileInfo.category,
            extension: ext,
            createdAt: stats.birthtimeMs || stats.mtimeMs,
            updatedAt: stats.mtimeMs
          });
        }
      }
    };
    
    traverse(workerDir);
    
    return { files, directories };
  }

  // Get file tree structure
  getTree(workerId, pathFilter = '') {
    const workerDir = this._getWorkerDir(workerId);
    if (!fs.existsSync(workerDir)) {
      return [];
    }

    const tree = [];
    const basePath = pathFilter ? path.join(workerDir, pathFilter) : workerDir;
    
    if (!fs.existsSync(basePath)) {
      return [];
    }

    const stats = fs.statSync(basePath);
    if (stats.isFile()) {
      const ext = path.extname(pathFilter || path.basename(basePath)).toLowerCase();
      const fileInfo = FILE_TYPES[ext] || { type: 'unknown', category: 'other' };
      return [{
        name: path.basename(basePath),
        path: this._getRelativePath(workerId, basePath),
        type: 'file',
        fileType: fileInfo.type,
        category: fileInfo.category,
        size: stats.size,
        extension: ext
      }];
    }

    const items = fs.readdirSync(basePath);
    for (const item of items) {
      const fullPath = path.join(basePath, item);
      const itemPath = pathFilter ? path.join(pathFilter, item) : item;
      const itemStats = fs.statSync(fullPath);
      
      if (itemStats.isDirectory()) {
        const children = this.getTree(workerId, itemPath);
        tree.push({
          name: item,
          path: itemPath,
          type: 'directory',
          children
        });
      } else {
        const ext = path.extname(item).toLowerCase();
        const fileInfo = FILE_TYPES[ext] || { type: 'unknown', category: 'other' };
        tree.push({
          name: item,
          path: itemPath,
          type: 'file',
          fileType: fileInfo.type,
          category: fileInfo.category,
          size: itemStats.size,
          extension: ext
        });
      }
    }
    
    return tree;
  }

  // Read file content
  read(workerId, filePath) {
    const fullPath = this._getFilePath(workerId, filePath);
    
    if (!fs.existsSync(fullPath)) {
      return { ok: false, error: 'File not found' };
    }
    
    const stats = fs.statSync(fullPath);
    if (!stats.isFile()) {
      return { ok: false, error: 'Path is not a file' };
    }
    
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const ext = path.extname(filePath).toLowerCase();
      const fileInfo = FILE_TYPES[ext] || { type: 'unknown' };
      
      return {
        ok: true,
        content,
        size: stats.size,
        type: fileInfo.type,
        path: filePath,
        name: path.basename(filePath),
        updatedAt: stats.mtimeMs
      };
    } catch (e) {
      return { ok: false, error: `Error reading file: ${e.message}` };
    }
  }

  // Write file content
  write(workerId, filePath, content, options = {}) {
    const fullPath = this._getFilePath(workerId, filePath);
    
    // Ensure directory exists
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Validate file type and size
    const ext = path.extname(filePath).toLowerCase();
    const fileInfo = FILE_TYPES[ext] || { type: 'unknown', maxSize: 1048576 };
    
    if (Buffer.byteLength(content) > (options.maxSize || fileInfo.maxSize)) {
      return { ok: false, error: `File too large. Max size: ${fileInfo.maxSize} bytes` };
    }
    
    try {
      fs.writeFileSync(fullPath, content, 'utf8');
      
      // Update metadata
      const metadata = this.getMetadata(workerId) || { files: {} };
      metadata.files[filePath] = {
        size: Buffer.byteLength(content),
        type: fileInfo.type,
        category: fileInfo.category,
        updatedAt: Date.now(),
        createdAt: metadata.files[filePath]?.createdAt || Date.now()
      };
      this.updateMetadata(workerId, { files: metadata.files });
      
      return {
        ok: true,
        path: filePath,
        size: Buffer.byteLength(content),
        type: fileInfo.type
      };
    } catch (e) {
      return { ok: false, error: `Error writing file: ${e.message}` };
    }
  }

  // Delete a file
  delete(workerId, filePath) {
    const fullPath = this._getFilePath(workerId, filePath);
    
    if (!fs.existsSync(fullPath)) {
      return { ok: false, error: 'File not found' };
    }
    
    try {
      fs.unlinkSync(fullPath);
      
      // Update metadata
      const metadata = this.getMetadata(workerId) || { files: {} };
      if (metadata.files[filePath]) {
        delete metadata.files[filePath];
        this.updateMetadata(workerId, { files: metadata.files });
      }
      
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: `Error deleting file: ${e.message}` };
    }
  }

  // Create a directory
  createDir(workerId, dirPath) {
    const fullPath = this._getFilePath(workerId, dirPath);
    
    try {
      if (fs.existsSync(fullPath)) {
        return { ok: false, error: 'Directory already exists' };
      }
      
      fs.mkdirSync(fullPath, { recursive: true });
      return { ok: true, path: dirPath };
    } catch (e) {
      return { ok: false, error: `Error creating directory: ${e.message}` };
    }
  }

  // Delete a directory (recursive)
  deleteDir(workerId, dirPath) {
    const fullPath = this._getFilePath(workerId, dirPath);
    
    if (!fs.existsSync(fullPath)) {
      return { ok: false, error: 'Directory not found' };
    }
    
    try {
      const stats = fs.statSync(fullPath);
      if (!stats.isDirectory()) {
        return { ok: false, error: 'Path is not a directory' };
      }
      
      // Remove all files and subdirectories
      const items = fs.readdirSync(fullPath);
      for (const item of items) {
        const itemPath = path.join(fullPath, item);
        const itemStats = fs.statSync(itemPath);
        
        if (itemStats.isDirectory()) {
          this.deleteDir(workerId, path.join(dirPath, item));
        } else {
          fs.unlinkSync(itemPath);
        }
      }
      
      fs.rmdirSync(fullPath);
      
      // Update metadata - remove all files in this directory
      const metadata = this.getMetadata(workerId) || { files: {} };
      const newFiles = {};
      
      for (const [filePath, info] of Object.entries(metadata.files)) {
        if (!filePath.startsWith(dirPath + '/') && filePath !== dirPath) {
          newFiles[filePath] = info;
        }
      }
      
      this.updateMetadata(workerId, { files: newFiles });
      
      return { ok: true, path: dirPath };
    } catch (e) {
      return { ok: false, error: `Error deleting directory: ${e.message}` };
    }
  }

  // Upload multiple files at once
  uploadBatch(workerId, files) {
    const results = {
      success: [],
      failed: []
    };
    
    for (const file of files) {
      const result = this.write(workerId, file.path, file.content, { maxSize: file.maxSize });
      if (result.ok) {
        results.success.push(result);
      } else {
        results.failed.push({ ...file, error: result.error });
      }
    }
    
    return {
      ok: results.failed.length === 0,
      success: results.success.length,
      failed: results.failed.length,
      results
    };
  }

  // Upload a ZIP archive
  async uploadZip(workerId, zipFilePath, options = {}) {
    const workerDir = this._getWorkerDir(workerId);
    const tempDir = path.join(this.baseDir, 'temp', genId());
    
    try {
      // Create temp directory
      fs.mkdirSync(tempDir, { recursive: true });
      
      // Extract ZIP
      await extract(zipFilePath, { dir: tempDir });
      
      // Get all extracted files
      const extractedFiles = [];
      const traverse = (dir) => {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const fullPath = path.join(dir, item);
          const stats = fs.statSync(fullPath);
          
          if (stats.isDirectory()) {
            traverse(fullPath);
          } else {
            const relativePath = path.relative(tempDir, fullPath);
            extractedFiles.push({
              path: relativePath,
              content: fs.readFileSync(fullPath, 'utf8'),
              size: stats.size
            });
          }
        }
      };
      
      traverse(tempDir);
      
      // Upload all files to worker directory
      const results = [];
      for (const file of extractedFiles) {
        const targetPath = path.join(workerDir, file.path);
        const targetDir = path.dirname(targetPath);
        
        // Ensure directory exists
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        
        // Write file
        fs.writeFileSync(targetPath, file.content, 'utf8');
        results.push({ path: file.path, size: file.size });
      }
      
      // Update metadata
      const metadata = this.getMetadata(workerId) || { files: {} };
      for (const result of results) {
        const ext = path.extname(result.path).toLowerCase();
        const fileInfo = FILE_TYPES[ext] || { type: 'unknown', category: 'other' };
        metadata.files[result.path] = {
          size: result.size,
          type: fileInfo.type,
          category: fileInfo.category,
          updatedAt: Date.now(),
          createdAt: metadata.files[result.path]?.createdAt || Date.now()
        };
      }
      this.updateMetadata(workerId, { files: metadata.files });
      
      // Cleanup temp directory
      this._cleanupTemp(tempDir);
      
      return {
        ok: true,
        files: results.length,
        size: results.reduce((sum, f) => sum + f.size, 0)
      };
    } catch (e) {
      // Cleanup temp directory on error
      this._cleanupTemp(tempDir);
      return { ok: false, error: `Error extracting ZIP: ${e.message}` };
    }
  }

  // Download all files as ZIP
  async downloadZip(workerId, options = {}) {
    const workerDir = this._getWorkerDir(workerId);
    const tempZipPath = path.join(this.baseDir, 'temp', genId() + '.zip');
    
    try {
      // Ensure worker directory exists
      if (!fs.existsSync(workerDir)) {
        return { ok: false, error: 'Worker directory not found' };
      }
      
      // Create ZIP archive
      const output = fs.createWriteStream(tempZipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      
      output.on('close', () => {
        // Cleanup after download
        setTimeout(() => {
          try { fs.unlinkSync(tempZipPath); } catch (e) {}
        }, 300000); // 5 minutes
      });
      
      archive.on('error', (err) => {
        throw err;
      });
      
      archive.pipe(output);
      archive.directory(workerDir, false);
      archive.finalize();
      
      await new Promise((resolve, reject) => {
        output.on('close', resolve);
        archive.on('error', reject);
      });
      
      return {
        ok: true,
        path: tempZipPath,
        size: fs.statSync(tempZipPath).size
      };
    } catch (e) {
      return { ok: false, error: `Error creating ZIP: ${e.message}` };
    }
  }

  // Get file statistics
  stats(workerId) {
    const metadata = this.getMetadata(workerId);
    if (!metadata) {
      return {
        totalFiles: 0,
        totalSize: 0,
        byType: {},
        byCategory: {}
      };
    }
    
    const stats = {
      totalFiles: Object.keys(metadata.files).length,
      totalSize: 0,
      byType: {},
      byCategory: {}
    };
    
    for (const [filePath, info] of Object.entries(metadata.files)) {
      stats.totalSize += info.size;
      
      stats.byType[info.type] = (stats.byType[info.type] || 0) + 1;
      stats.byCategory[info.category] = (stats.byCategory[info.category] || 0) + 1;
    }
    
    return stats;
  }

  // Get file history (if versioning is enabled)
  getHistory(workerId, filePath) {
    // This would be implemented with a versioning system
    // For now, return empty array
    return [];
  }

  // Rollback a file to previous version
  rollback(workerId, filePath, version) {
    // This would be implemented with a versioning system
    return { ok: false, error: 'File versioning not yet implemented' };
  }

  // Create default file structure for a new worker
  createDefaultStructure(workerId, options = {}) {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return { ok: false, error: 'Worker not found' };
    }
    
    const filesToCreate = { ...DEFAULT_STRUCTURE };
    
    // Add worker-specific files
    if (worker.name) {
      filesToCreate['config.json'] = JSON.stringify({
        name: worker.name,
        version: '1.0.0',
        description: worker.name,
        workerId: workerId
      }, null, 2);
    }
    
    // Add main worker file based on template
    if (worker.slug) {
      filesToCreate['index.js'] = filesToCreate['index.js'].replace(
        'Hello from worker!',
        `Hello from ${worker.name || worker.slug}!`
      );
    }
    
    // Create all files
    const results = [];
    for (const [filePath, content] of Object.entries(filesToCreate)) {
      const result = this.write(workerId, filePath, content);
      if (result.ok) {
        results.push(result);
      }
    }
    
    return {
      ok: true,
      created: results.length,
      files: results
    };
  }

  // Cleanup temporary files
  _cleanupTemp(dirPath) {
    try {
      if (fs.existsSync(dirPath)) {
        const items = fs.readdirSync(dirPath);
        for (const item of items) {
          const fullPath = path.join(dirPath, item);
          const stats = fs.statSync(fullPath);
          
          if (stats.isDirectory()) {
            this._cleanupTemp(fullPath);
          } else {
            fs.unlinkSync(fullPath);
          }
        }
        fs.rmdirSync(dirPath);
      }
    } catch (e) {
      console.error('[WorkerFiles] Error cleaning up temp directory:', e.message);
    }
  }

  // Validate file path
  validatePath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, error: 'Invalid file path' };
    }
    
    // Prevent directory traversal
    if (filePath.includes('../') || filePath.startsWith('/') || filePath.includes('\\..\\')) {
      return { ok: false, error: 'Invalid file path: directory traversal not allowed' };
    }
    
    // Check for invalid characters
    if (/[<>:"|?*]/.test(filePath)) {
      return { ok: false, error: 'Invalid file path: contains invalid characters' };
    }
    
    return { ok: true };
  }

  // Get file type information
  getFileTypeInfo(extension) {
    const ext = extension.toLowerCase();
    return FILE_TYPES[ext] || { type: 'unknown', maxSize: 1048576, category: 'other' };
  }

  // Get all supported extensions
  getSupportedExtensions() {
    return Object.keys(FILE_TYPES);
  }

  // Get file icon based on type
  getFileIcon(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const icons = {
      '.js': '📜', '.mjs': '📜', '.cjs': '📜',
      '.json': '📋', '.yaml': '📋', '.yml': '📋',
      '.env': '🔑',
      '.txt': '📄', '.md': '📝',
      '.csv': '📊', '.xml': '📊',
      '.png': '🖼️', '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.svg': '🖼️',
      '.zip': '🗄️'
    };
    return icons[ext] || '📁';
  }
}

module.exports = WorkerFiles;
