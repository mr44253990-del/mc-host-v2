'use strict';
// Enhanced file upload system for bots, workers, and configurations
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { genId } = require('./util');

// File type configurations
const FILE_CONFIG = {
  // Bot files
  botScript: {
    extensions: ['.js', '.mjs', '.cjs'],
    maxSize: 1048576, // 1MB
    uploadDir: 'bot-scripts',
    category: 'bot'
  },
  
  // Worker files
  workerScript: {
    extensions: ['.js', '.mjs', '.cjs'],
    maxSize: 1048576,
    uploadDir: 'worker-scripts',
    category: 'worker'
  },
  
  // Configuration files
  config: {
    extensions: ['.json', '.yaml', '.yml'],
    maxSize: 524288, // 500KB
    uploadDir: 'configs',
    category: 'config'
  },
  
  // Environment files
  env: {
    extensions: ['.env'],
    maxSize: 52428, // 50KB
    uploadDir: 'envs',
    category: 'env'
  },
  
  // Text files
  text: {
    extensions: ['.txt', '.md', '.csv', '.xml'],
    maxSize: 209715, // 200KB
    uploadDir: 'texts',
    category: 'text'
  },
  
  // Archive files
  archive: {
    extensions: ['.zip'],
    maxSize: 5242880, // 5MB
    uploadDir: 'archives',
    category: 'archive'
  },
  
  // Image files
  image: {
    extensions: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'],
    maxSize: 2097152, // 2MB
    uploadDir: 'images',
    category: 'image'
  }
};

// MIME type to file type mapping
const MIME_TO_TYPE = {
  'text/javascript': 'botScript',
  'application/javascript': 'botScript',
  'text/x-javascript': 'botScript',
  'module': 'botScript',
  
  'application/json': 'config',
  'text/yaml': 'config',
  'application/x-yaml': 'config',
  
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/csv': 'text',
  'application/xml': 'text',
  
  'application/x-zip-compressed': 'archive',
  'application/zip': 'archive',
  
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/svg+xml': 'image',
  'image/webp': 'image'
};

// Extension to MIME type mapping
const EXT_TO_MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.env': 'text/plain',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

class FileUpload {
  constructor(store, options = {}) {
    this.store = store;
    this.baseDir = options.baseDir || path.join(store.dir, 'uploads');
    this.tempDir = path.join(this.baseDir, 'temp');
    
    // Ensure directories exist
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.mkdirSync(this.tempDir, { recursive: true });
    
    // Configure multer for file uploads
    this.storage = multer.diskStorage({
      destination: (req, file, cb) => {
        const uploadDir = this._getUploadDir(req);
        fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + genId().slice(0, 8);
        const ext = path.extname(file.originalname).toLowerCase();
        const basename = path.basename(file.originalname, ext).slice(0, 100);
        cb(null, `${basename}-${uniqueSuffix}${ext}`);
      }
    });
    
    this.uploader = multer({
      storage: this.storage,
      limits: {
        fileSize: options.maxFileSize || 5242880, // 5MB default
        files: options.maxFiles || 10
      },
      fileFilter: this._fileFilter.bind(this)
    });
    
    // File registry for tracking uploaded files
    this.registry = new Map();
    this._loadRegistry();
  }

  _loadRegistry() {
    const registryPath = path.join(this.baseDir, '.file-registry.json');
    if (fs.existsSync(registryPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        this.registry = new Map(Object.entries(data));
      } catch (e) {
        console.error('[FileUpload] Error loading registry:', e.message);
      }
    }
  }

  _saveRegistry() {
    const registryPath = path.join(this.baseDir, '.file-registry.json');
    const data = Object.fromEntries(this.registry);
    fs.writeFileSync(registryPath, JSON.stringify(data, null, 2));
  }

  _getUploadDir(req) {
    // Determine upload directory based on request context
    const category = req.body?.category || req.query?.category || 'general';
    const config = FILE_CONFIG[category] || FILE_CONFIG.text;
    return path.join(this.baseDir, config.uploadDir);
  }

  _fileFilter(req, file, cb) {
    // Validate file type and extension
    const ext = path.extname(file.originalname).toLowerCase();
    
    // Check if extension is allowed
    let allowed = false;
    for (const [type, config] of Object.entries(FILE_CONFIG)) {
      if (config.extensions.includes(ext)) {
        allowed = true;
        break;
      }
    }
    
    if (!allowed) {
      return cb(new Error(`Invalid file type: ${ext}`), false);
    }
    
    // Check MIME type
    const mimeType = file.mimetype;
    const detectedType = MIME_TO_TYPE[mimeType];
    
    if (detectedType && !FILE_CONFIG[detectedType].extensions.includes(ext)) {
      return cb(new Error(`File extension does not match MIME type`), false);
    }
    
    cb(null, true);
  }

  // Get multer middleware for express
  getMiddleware(options = {}) {
    const fieldName = options.fieldName || 'file';
    const maxFiles = options.maxFiles || 1;
    
    if (maxFiles === 1) {
      return this.uploader.single(fieldName);
    }
    
    return this.uploader.array(fieldName, maxFiles);
  }

  // Handle single file upload
  async handleUpload(req, res, options = {}) {
    const fieldName = options.fieldName || 'file';
    const category = req.body?.category || req.query?.category || 'general';
    
    return new Promise((resolve, reject) => {
      this.uploader.single(fieldName)(req, res, (err) => {
        if (err) {
          return reject(err);
        }
        
        if (!req.file) {
          return reject(new Error('No file uploaded'));
        }
        
        const fileInfo = this._processUploadedFile(req.file, category, req);
        resolve(fileInfo);
      });
    });
  }

  // Handle multiple file uploads
  async handleMultipleUploads(req, res, options = {}) {
    const fieldName = options.fieldName || 'files';
    const category = req.body?.category || req.query?.category || 'general';
    
    return new Promise((resolve, reject) => {
      this.uploader.array(fieldName, options.maxFiles || 10)(req, res, (err) => {
        if (err) {
          return reject(err);
        }
        
        if (!req.files || req.files.length === 0) {
          return reject(new Error('No files uploaded'));
        }
        
        const files = req.files.map(file => 
          this._processUploadedFile(file, category, req)
        );
        
        resolve(files);
      });
    });
  }

  _processUploadedFile(file, category, req) {
    const ext = path.extname(file.originalname).toLowerCase();
    const config = FILE_CONFIG[category] || Object.values(FILE_CONFIG).find(c => c.extensions.includes(ext)) || FILE_CONFIG.text;
    
    const fileInfo = {
      id: genId(),
      originalName: file.originalname,
      storedName: file.filename,
      path: file.path,
      size: file.size,
      mimeType: file.mimetype,
      extension: ext,
      category: config.category,
      type: category,
      uploadedAt: Date.now(),
      uploadedBy: req.user?.id || req.ip || 'unknown',
      metadata: {
        width: null,
        height: null,
        lines: null,
        ...this._extractMetadata(file.path, ext)
      }
    };
    
    // Register the file
    this.registry.set(fileInfo.id, fileInfo);
    this._saveRegistry();
    
    return fileInfo;
  }

  _extractMetadata(filePath, ext) {
    const metadata = {};
    
    try {
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
        // For images, we could extract dimensions
        // This would require an image processing library
        metadata.type = 'image';
      } else if (['.js', '.mjs', '.cjs', '.json', '.txt', '.md', '.yaml', '.yml', '.env', '.csv', '.xml'].includes(ext)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          metadata.lines = content.split('\n').length;
          metadata.size = content.length;
          
          if (['.js', '.mjs', '.cjs'].includes(ext)) {
            metadata.type = 'script';
            // Count functions, classes, etc.
            const functionCount = (content.match(/function\s/g) || []).length;
            const classCount = (content.match(/class\s/g) || []).length;
            metadata.functions = functionCount;
            metadata.classes = classCount;
          } else if (['.json', '.yaml', '.yml'].includes(ext)) {
            metadata.type = 'config';
          } else if (['.md'].includes(ext)) {
            metadata.type = 'markdown';
          } else if (['.txt'].includes(ext)) {
            metadata.type = 'text';
          }
        } catch (e) {
          // File might be binary or invalid encoding
          metadata.type = 'binary';
        }
      }
    } catch (e) {
      console.error('[FileUpload] Error extracting metadata:', e.message);
    }
    
    return metadata;
  }

  // Save file directly (without upload)
  saveFile(content, options = {}) {
    const {
      filename,
      category = 'general',
      extension = '.txt',
      uploadedBy = 'system'
    } = options;
    
    const config = FILE_CONFIG[category] || FILE_CONFIG.text;
    const uploadDir = path.join(this.baseDir, config.uploadDir);
    fs.mkdirSync(uploadDir, { recursive: true });
    
    const uniqueSuffix = Date.now() + '-' + genId().slice(0, 8);
    const basename = (filename || 'file') + (extension || '');
    const storedName = `${path.basename(basename, path.extname(basename))}-${uniqueSuffix}${path.extname(basename) || extension}`;
    const filePath = path.join(uploadDir, storedName);
    
    fs.writeFileSync(filePath, content, 'utf8');
    
    const fileInfo = {
      id: genId(),
      originalName: filename || storedName,
      storedName,
      path: filePath,
      size: Buffer.byteLength(content),
      mimeType: EXT_TO_MIME[extension] || 'text/plain',
      extension: extension || '.txt',
      category: config.category,
      type: category,
      uploadedAt: Date.now(),
      uploadedBy,
      metadata: this._extractMetadata(filePath, extension)
    };
    
    this.registry.set(fileInfo.id, fileInfo);
    this._saveRegistry();
    
    return fileInfo;
  }

  // Get file by ID
  getFile(fileId) {
    return this.registry.get(fileId) || null;
  }

  // Get file content
  getFileContent(fileId) {
    const fileInfo = this.getFile(fileId);
    if (!fileInfo) {
      return { ok: false, error: 'File not found' };
    }
    
    try {
      const content = fs.readFileSync(fileInfo.path, 'utf8');
      return { ok: true, content, ...fileInfo };
    } catch (e) {
      return { ok: false, error: `Error reading file: ${e.message}` };
    }
  }

  // Get file as buffer (for downloads)
  getFileBuffer(fileId) {
    const fileInfo = this.getFile(fileId);
    if (!fileInfo) {
      return { ok: false, error: 'File not found' };
    }
    
    try {
      const buffer = fs.readFileSync(fileInfo.path);
      return { ok: true, buffer, ...fileInfo };
    } catch (e) {
      return { ok: false, error: `Error reading file: ${e.message}` };
    }
  }

  // Delete a file
  deleteFile(fileId) {
    const fileInfo = this.getFile(fileId);
    if (!fileInfo) {
      return { ok: false, error: 'File not found' };
    }
    
    try {
      fs.unlinkSync(fileInfo.path);
      this.registry.delete(fileId);
      this._saveRegistry();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `Error deleting file: ${e.message}` };
    }
  }

  // List files by category
  listFiles(options = {}) {
    const { category, type, limit = 100, offset = 0, sortBy = 'uploadedAt', sortOrder = 'desc' } = options;
    
    let files = Array.from(this.registry.values());
    
    // Filter by category
    if (category) {
      files = files.filter(f => f.category === category);
    }
    
    // Filter by type
    if (type) {
      files = files.filter(f => f.type === type);
    }
    
    // Sort
    files.sort((a, b) => {
      const aVal = a[sortBy] || 0;
      const bVal = b[sortBy] || 0;
      return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
    });
    
    // Paginate
    const paginated = files.slice(offset, offset + limit);
    
    return {
      files: paginated,
      total: files.length,
      offset,
      limit
    };
  }

  // Search files
  searchFiles(query, options = {}) {
    const { category, limit = 50 } = options;
    const files = Array.from(this.registry.values());
    
    const results = files.filter(file => {
      const matchesCategory = !category || file.category === category;
      const matchesQuery = file.originalName.toLowerCase().includes(query.toLowerCase()) ||
                          file.type.toLowerCase().includes(query.toLowerCase());
      return matchesCategory && matchesQuery;
    });
    
    return results.slice(0, limit);
  }

  // Get file statistics
  getStats() {
    const files = Array.from(this.registry.values());
    
    const stats = {
      total: files.length,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      byCategory: {},
      byType: {},
      byExtension: {},
      recent: files.slice(0, 10)
    };
    
    for (const file of files) {
      stats.byCategory[file.category] = (stats.byCategory[file.category] || 0) + 1;
      stats.byType[file.type] = (stats.byType[file.type] || 0) + 1;
      stats.byExtension[file.extension] = (stats.byExtension[file.extension] || 0) + 1;
    }
    
    return stats;
  }

  // Cleanup old files
  cleanupOldFiles(options = {}) {
    const { maxAge = 30, category, dryRun = false } = options; // 30 days default
    const maxAgeMs = maxAge * 24 * 60 * 60 * 1000;
    const now = Date.now();
    
    const files = Array.from(this.registry.entries());
    const toDelete = [];
    
    for (const [fileId, fileInfo] of files) {
      if (category && fileInfo.category !== category) continue;
      
      const age = now - fileInfo.uploadedAt;
      if (age > maxAgeMs) {
        toDelete.push(fileId);
      }
    }
    
    if (dryRun) {
      return { ok: true, wouldDelete: toDelete.length, files: toDelete.map(id => this.getFile(id)) };
    }
    
    const deleted = [];
    const errors = [];
    
    for (const fileId of toDelete) {
      const result = this.deleteFile(fileId);
      if (result.ok) {
        deleted.push(fileId);
      } else {
        errors.push({ fileId, error: result.error });
      }
    }
    
    return {
      ok: errors.length === 0,
      deleted: deleted.length,
      errors,
      files: deleted.map(id => this.getFile(id))
    };
  }

  // Cleanup temp directory
  cleanupTemp() {
    try {
      const files = fs.readdirSync(this.tempDir);
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        const stats = fs.statSync(filePath);
        
        // Delete files older than 1 hour
        if (now - stats.mtimeMs > oneHour) {
          fs.unlinkSync(filePath);
        }
      }
      
      return { ok: true, cleaned: files.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Get supported file types
  getSupportedTypes() {
    return Object.entries(FILE_CONFIG).map(([type, config]) => ({
      type,
      category: config.category,
      extensions: config.extensions,
      maxSize: config.maxSize,
      description: this._getTypeDescription(type)
    }));
  }

  _getTypeDescription(type) {
    const descriptions = {
      botScript: 'Minecraft bot scripts (JavaScript)',
      workerScript: 'Cloudflare Worker scripts',
      config: 'Configuration files (JSON, YAML)',
      env: 'Environment variable files',
      text: 'Text files (TXT, Markdown, CSV, XML)',
      archive: 'Archive files (ZIP)',
      image: 'Image files (PNG, JPG, GIF, SVG, WebP)'
    };
    return descriptions[type] || 'General files';
  }

  // Validate file before upload
  validateFile(file, options = {}) {
    const { category } = options;
    const ext = path.extname(file.name || file.originalname || '').toLowerCase();
    
    // Check extension
    let config = FILE_CONFIG[category] || Object.values(FILE_CONFIG).find(c => c.extensions.includes(ext));
    if (!config) {
      return { ok: false, error: `Unsupported file extension: ${ext}` };
    }
    
    // Check size
    const fileSize = file.size || Buffer.byteLength(file.content || '');
    if (fileSize > (options.maxSize || config.maxSize)) {
      return { ok: false, error: `File too large. Max size: ${config.maxSize} bytes` };
    }
    
    // Check MIME type if available
    if (file.mimetype) {
      const detectedType = MIME_TO_TYPE[file.mimetype];
      if (detectedType && !FILE_CONFIG[detectedType].extensions.includes(ext)) {
        return { ok: false, error: 'File extension does not match MIME type' };
      }
    }
    
    return { ok: true, type: category || config.category, config };
  }

  // Get file URL for serving
  getFileUrl(fileId, req) {
    const fileInfo = this.getFile(fileId);
    if (!fileInfo) {
      return null;
    }
    
    // In a real implementation, this would generate a signed URL
    // For now, return the path
    return `/uploads/${fileInfo.category}/${fileInfo.storedName}`;
  }

  // Serve file for download
  serveFile(fileId, res) {
    const fileInfo = this.getFile(fileId);
    if (!fileInfo) {
      res.status(404).json({ ok: false, error: 'File not found' });
      return false;
    }
    
    try {
      const filePath = fileInfo.path;
      const stats = fs.statSync(filePath);
      
      // Set appropriate headers
      res.setHeader('Content-Type', fileInfo.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileInfo.originalName)}"`);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      
      // Stream the file
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
      
      return true;
    } catch (e) {
      res.status(500).json({ ok: false, error: `Error serving file: ${e.message}` });
      return false;
    }
  }

  // Create a file from URL (download)
  async createFromUrl(url, options = {}) {
    const { category = 'general', filename } = options;
    
    try {
      // This would require a fetch/axios implementation
      // For now, return a placeholder
      return { ok: false, error: 'URL download not yet implemented' };
    } catch (e) {
      return { ok: false, error: `Error downloading from URL: ${e.message}` };
    }
  }

  // Update file metadata
  updateMetadata(fileId, metadata) {
    const fileInfo = this.getFile(fileId);
    if (!fileInfo) {
      return { ok: false, error: 'File not found' };
    }
    
    const updated = { ...fileInfo, metadata: { ...fileInfo.metadata, ...metadata } };
    this.registry.set(fileId, updated);
    this._saveRegistry();
    
    return { ok: true, file: updated };
  }

  // Get file by original name
  getFileByName(name, category) {
    const files = Array.from(this.registry.values());
    return files.find(f => 
      f.originalName === name && (!category || f.category === category)
    ) || null;
  }

  // Check if file exists
  fileExists(fileId) {
    return this.registry.has(fileId);
  }

  // Get file path
  getFilePath(fileId) {
    const fileInfo = this.getFile(fileId);
    return fileInfo ? fileInfo.path : null;
  }
}

module.exports = FileUpload;
