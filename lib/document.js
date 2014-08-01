var PDFObject = require('./objects/object')
  , Pages     = require('./pages')
  , Font      = require('./font')
  , TTFFont   = require('./fonts/ttf')
  , PDFName   = require('./objects/name')
  , utils     = require('./utils')

var Document = module.exports = function Document(font, opts) {
  this.version = 1.3
  this.length  = 0
  this.xref    = []
  this.plugins = []

  // options
  if (!opts) opts = {}

  // list of all fonts in this document
  this.fonts       = []
  this.subsets     = []
  this.defaultFont = this.registerFont(font)

  this.opts         = opts || {}
  this.opts.width   = this.opts.width || 612
  this.opts.height  = this.opts.height || 792
  this.opts.padding = this.opts.padding || { top: 20, right: 40,
                                             bottom: 20, left: 40 }

  // call parents constructor
  Document.super_.call(this)

  // the catalog and pages tree
  this.pages   = new Pages(this)
  this.catalog = this.createObject('Catalog')
  this.catalog.prop('Pages', this.pages.toReference())

  this.areas = { header: null, footer: null }

  this.use('op',    require('./content/operation'))
  this.use('text',  require('./content/text'))
  this.use('table', require('./content/table'))

  // header
  this.push('%PDF-' + this.version.toString() + '\n')

  // The PDF format mandates that we add at least 4 commented binary characters
  // (ASCII value >= 128), so that generic tools have a chance to detect
  // that it's a binary file
  this.push('%\xFF\xFF\xFF\xFF\n\n')
  this.length += 4

  this.pagebreak()
}

var Readable = require('stream').Readable
utils.inherits(Document, Readable)

var Fragment = require('./fragment')

Document.Font = Font

// ;['header', 'footer'].forEach(function(area) {
//   Document.prototype[area] = function(opts, definition) {
//     if (typeof opts !== 'object') {
//       definition = opts
//       opts = {}
//     }
//     if (!opts.padding) opts.padding = { top: 0, right: this.padding.right, bottom: 0, left: this.padding.left }
//     this.areas[area] = new Fragment(this, opts)
//     if (typeof definition === 'function') {
//       definition.call(this.areas[area], this.areas[area])
//     } else {
//       this.areas[area].text(definition, opts)
//     }
//     return this
//   }
// })

Document.prototype.use = function(name, method) {
  if (name in this) {
    throw new TypeError(name + ' already in use')
  }

  this.plugins.push({ name: name, method: method })
  var doc = this
  this[name] = function() {
    method.apply(doc.cursor, arguments)
  }
}

Document.prototype.registerFont = function(font) {
  var index
  if ((index = this.fonts.indexOf(font)) > -1) return this.subsets[index]
  var id = this.fonts.push(font)
  this.subsets.push(font.subset(this, id))
  return this.subsets[id - 1]
}

Document.prototype.createObject = function(type) {
  var id = this.xref.push(null)
  var object = new PDFObject(id)
  if (type) object.addProperty('Type', type)
  // this.objects.push(object)
  return object
}

// Transaction
Document.prototype.startTransaction = function() {
  return new Transaction(this)
}

// Rendering

Document.prototype.pagebreak = function() {
  if (this.cursor) this.cursor.end()
  var page = this.cursor = this.pages.addPage()
  page.pageNumber = this.pages.pages.length
  // if (this.areas.header) {
  //   this.areas.header.height = 0
  //   this.areas.header.render(page, this.width)
  //   this.areas.header.height = this.height - page.cursor.y - this.opts.padding.top
  // }
  // if (this.areas.footer) {
  //   var footer = this.areas.footer
  //     , transaction = this.startTransaction()
  //     , y = page.cursor.y
  //   footer.height = 0
  //   footer.render(page, this.width)
  //   var height = y - page.cursor.y
  //   transaction.rollback()
  //   page.cursor.y = this.padding.bottom + height
  //   footer.render(page, this.width)
  //   page.cursor.y = y
  //   footer.height = height
  // }
  return page
}

Document.prototype.toDataURL = function() {
  return 'data:application/pdf;base64,' + Base64.encode(this.toString())
}

var PDFDictionary = require('./objects/dictionary')
  , PDFArray      = require('./objects/array')
  , PDFString     = require('./objects/string')
  , PDFStream     = require('./objects/stream')

Document.prototype.push = function(chunk) {
  if (chunk instanceof PDFObject) {
    this.xref[chunk.id - 1] = this.length
    chunk = chunk.toString() + '\n\n'
  }
  if (chunk) this.length += chunk.length
  Readable.prototype.push.call(this, chunk)
}

Document.prototype._read = function() {

}

Document.prototype.end = function() {
  // add most recent page
  while (!this.cursor.finished) {
    this.cursor.end()
  }

  // embed fonts
  this.subsets.forEach(function(subset) {
    subset.embed(this)
  }, this)

  // add catalog and page tree to
  this.push(this.catalog)
  this.push(this.pages.tree)

  // to support random access to individual objects, a PDF file
  // contains a cross-reference table that can be used to locate
  // and directly access pages and other important objects within the file
  var startxref = this.length
  this.push('xref\n')
  this.push('0 ' + (this.xref.length + 1) + '\n')
  this.push('0000000000 65535 f \n')
  this.xref.forEach(function(offset) {
    if (offset) {
      this.push('0000000000'.substr(offset.toString().length) + offset + ' 00000 n \n')
    } else {
      this.push('0000000000 00000 f \n')
    }
  }, this)

  // trailer
  var id = (new PDFString(uuid4())).toHexString()
    , trailer = new PDFDictionary({
      Size: this.xref.length,
      Root: this.catalog.toReference(),
      ID:   new PDFArray([id, id])
  })

  this.push('trailer\n')
  this.push(trailer.toString() + '\n')
  this.push('startxref\n')
  this.push(startxref + '\n')
  this.push('%%EOF')

  // end stream
  this.push(null)
}

// Transaction

var Transaction = function(doc) {
  this.doc = doc
  this.page = doc.pages.count - 1
  this.length = doc.cursor.contents.content.length
  this.y = doc.cursor.cursor.y
}

Transaction.prototype.rollback = function() {
  if (this.page < (this.doc.pages.count - 1)) {
    for (var i = this.doc.pages.count - 1; i > this.page; --i)
      this.doc.pages.removePageAt(i)
    this.doc.cursor = this.doc.pages.pages[this.page]
  }

  if (this.length < this.doc.cursor.contents.content.length) {
    this.doc.cursor.contents.slice(0, this.length)
  }

  this.doc.cursor.cursor.y = this.y
}

Transaction.prototype.commit = function() {
}

/**
*
*  Base64 encode / decode
*  http://www.webtoolkit.info/
*
**/
var Base64 = {
  // private property
  _keyStr : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",

  // public method for encoding
  encode : function (input) {
    var output = "";
    var chr1, chr2, chr3, enc1, enc2, enc3, enc4;
    var i = 0;

    input = Base64._utf8_encode(input);

    while (i < input.length) {
      chr1 = input.charCodeAt(i++);
      chr2 = input.charCodeAt(i++);
      chr3 = input.charCodeAt(i++);

      enc1 = chr1 >> 2;
      enc2 = ((chr1 & 3) << 4) | (chr2 >> 4);
      enc3 = ((chr2 & 15) << 2) | (chr3 >> 6);
      enc4 = chr3 & 63;

      if (isNaN(chr2)) {
          enc3 = enc4 = 64;
      } else if (isNaN(chr3)) {
          enc4 = 64;
      }

      output = output +
      this._keyStr.charAt(enc1) + this._keyStr.charAt(enc2) +
      this._keyStr.charAt(enc3) + this._keyStr.charAt(enc4);
    }

    return output;
  },

  // private method for UTF-8 encoding
  _utf8_encode : function (string) {
    string = string.replace(/\r\n/g,"\n");
    var utftext = "";

    for (var n = 0; n < string.length; n++) {
      var c = string.charCodeAt(n);

      // workaround to not encode UTF8 characters
      // TODO: improve ...
      utftext += String.fromCharCode(Math.min(c, 0xff))
      continue

      if (c < 128) {
        utftext += String.fromCharCode(c);
      }
      else if((c > 127) && (c < 2048)) {
        utftext += String.fromCharCode((c >> 6) | 192);
        utftext += String.fromCharCode((c & 63) | 128);
      }
      else {
        utftext += String.fromCharCode((c >> 12) | 224);
        utftext += String.fromCharCode(((c >> 6) & 63) | 128);
        utftext += String.fromCharCode((c & 63) | 128);
      }
    }

    return utftext;
  }
}

// UUID v4
// source: https://gist.github.com/jed/982883
function uuid4(
  a                  // placeholder
){
  return a           // if the placeholder was passed, return
    ? (              // a random number from 0 to 15
      a ^            // unless b is 8,
      Math.random()  // in which case
      * 16           // a random number from
      >> a/4         // 8 to 11
      ).toString(16) // in hexadecimal
    : (              // or otherwise a concatenated string:
      [1e7] +        // 10000000 +
      -1e3 +         // -1000 +
      -4e3 +         // -4000 +
      -8e3 +         // -80000000 +
      -1e11          // -100000000000,
      ).replace(     // replacing
        /[018]/g,    // zeroes, ones, and eights with
        uuid4        // random hex digits
      )
}