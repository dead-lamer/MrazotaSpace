const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const app = express();
app.use(express.json());
const https = require('https');
const crypto = require('crypto');
const helpers = require('./helpers');
const fs = require('fs');
const path = require('path');
const validateInput = (input, maxLength = 1000) => {
  if (typeof input !== 'string') return false;
  if (input.length > maxLength) return false;
  return /^[\w\s\p{L}.,!?()@#$%^&*\-+=:;'"<>\/\\[\]{}|~`€£¥§–—―…]{1,1000}$/u.test(input);
};
const adminIP = '127.0.0.1'; 

/*const limiter = rateLimit({
  windowMs: 15 * 1000, 
  max: 2, 
  message: "Too many requests, please try again later",
});*/

/*const options = {
  key: fs.readFileSync('/'),
  cert: fs.readFileSync('/'),
};*/

// Настройка шаблонизатора EJS
app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.locals.formatDate = helpers.formatDate;
app.locals.adminIP = adminIP;
// Подключение к БД
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error(err.message);
  console.log('Connected to the database.');
});

const checkThreadExists = (req, res, next) => {
  const threadId = parseInt(req.params.id, 10);
  
  if (isNaN(threadId)) {
    return res.status(404).render('404');
  }

  db.get('SELECT id FROM threads WHERE id = ?', [threadId], (err, row) => {
    if (err) return next(err);
    if (!row) return res.status(404).render('404');
    next();
  });
};

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      content TEXT NOT NULL,
      user_ip TEXT NOT NULL,
      likes_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      user_ip TEXT NOT NULL,
      likes_count INTEGER DEFAULT 0,  
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(thread_id) REFERENCES threads(id)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS likes_log (
      hash TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS post_likes_log (
      hash TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});


function generateHash(req, id) {
  const ip = req.ip;
  const userAgent = req.get('User-Agent');
  const ua = userAgent ? userAgent.slice(0, 50) : 'unknown';  
  const clientToken = req.body.clientToken || 'notoken'; 

  return crypto
    .createHash('sha256')
    .update(`${ip}-${ua}-${id}-${clientToken}`)//`
    .digest('hex');
}

app.get('/.well-known/acme-challenge/:token', (req, res) => {
  const token = req.params.token;
  res.sendFile(path.join(__dirname, '.well-known', 'acme-challenge', token));
});


app.get('/', (req, res) => {
  db.all(`SELECT threads.*,
      COALESCE(MAX(posts.created_at), threads.created_at) AS last_activity
    FROM threads
    LEFT JOIN posts ON threads.id = posts.thread_id
    GROUP BY threads.id
    ORDER BY last_activity DESC`, (err, threads) => {
    if (err) return console.error(err);
    res.render('index', { threads });
  });
});

app.get('/thread/:id(\\d+)', checkThreadExists, (req, res) => {
  const threadId = parseInt(req.params.id, 10);

  db.get('SELECT * FROM threads WHERE id = ?', [threadId], (err, thread) => {
    if (err) return res.status(500).send('Ошибка сервера');
    if (!thread) return res.status(404).render('404');

    db.all(
      'SELECT *, likes_count FROM posts WHERE thread_id = ? ORDER BY created_at',
      [threadId],
      (err, posts) => {
        if (err) return res.status(500).send('Ошибка сервера');
        res.render('thread', { thread, posts });
      }
    );
  });
});

app.post('/thread', (req, res) => {
  const { title, content } = req.body;
  const userIP = req.ip;
  
  if (!validateInput(content)) {
    return res.status(400).send('Недопустимое содержимое');
  }
  db.run(
    'INSERT INTO threads (title, content, user_ip) VALUES (?, ?, ?)',
    [title || 'Анонимный тред', content, userIP],
    (err) => {
      if (err) return console.error(err);
      res.redirect('/');
    }
  );
});

app.post('/thread/:id/comment', checkThreadExists, (req, res) => {
  const threadId = req.params.id;
  const { content } = req.body;
  const userIP = req.ip;
  
  db.run(
    'INSERT INTO posts (thread_id, content, user_ip) VALUES (?, ?, ?)',
    [threadId, content, userIP],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Ошибка при добавлении комментария');
      }
      
      res.redirect(`/thread/${threadId}`);
    }
  );
});


app.post('/like', (req, res) => {
  const { threadId } = req.body;
  const parsedThreadId = parseInt(threadId);

  if (!threadId || isNaN(parsedThreadId)) {
    return res.status(400).json({ error: 'Не указан ID треда' });
  }

  const hash = generateHash(req, parsedThreadId);

  db.serialize(() => {
    db.run('BEGIN TRANSACTION', (err) => {
      if (err) {
        console.error('Ошибка начала транзакции:', err);
        return res.status(500).json({ error: 'Ошибка сервера' });
      }


      db.get('SELECT id FROM threads WHERE id = ?', [parsedThreadId], (err, threadRow) => {
        if (err) {
          return db.run('ROLLBACK', () => res.status(500).json({ error: 'Ошибка сервера' }));
        }
        if (!threadRow) {
          return db.run('ROLLBACK', () => res.status(404).json({ error: `Тред с ID ${parsedThreadId} не найден` }));
        }


        db.get('SELECT 1 FROM likes_log WHERE hash = ?', [hash], (err, likeRow) => {
          if (err) {
            return db.run('ROLLBACK', () => res.status(500).json({ error: 'Ошибка сервера' }));
          }
          if (likeRow) {
            return db.run('ROLLBACK', () => res.status(400).json({ error: 'Вы уже лайкнули этот пост!' }));
          }


          db.run('UPDATE threads SET likes_count = likes_count + 1 WHERE id = ?', [parsedThreadId], (err) => {
            if (err) {
              return db.run('ROLLBACK', () => res.status(500).json({ error: 'Ошибка сервера' }));
            }


            db.run('INSERT INTO likes_log (hash) VALUES (?)', [hash], (err) => {
              if (err) {
                return db.run('ROLLBACK', () => res.status(500).json({ error: 'Ошибка сервера' }));
              }


              db.get('SELECT likes_count FROM threads WHERE id = ?', [parsedThreadId], (err, row) => {
                if (err) {
                  return db.run('ROLLBACK', () => res.status(500).json({ error: 'Ошибка сервера' }));
                }


                db.run('COMMIT', (err) => {
                  if (err) {
                    return res.status(500).json({ error: 'Ошибка завершения транзакции' });
                  }
                  res.json({ success: true, likes: row.likes_count });
                });
              });
            });
          });
        });
      });
    });
  });
});


app.post('/like-post', (req, res) => {
  const { postId } = req.body;
  const parsedPostId = parseInt(postId);

  if (!postId || isNaN(parsedPostId)) {
    return res.status(400).json({ error: 'Не указан ID поста' });
  }

  const hash = generateHash(req, parsedPostId); 

  db.serialize(() => {
    db.run('BEGIN TRANSACTION', (err) => {
      if (err) {
        console.error('Ошибка начала транзакции:', err);
        return res.status(500).json({ error: 'Ошибка сервера' });
      }

      db.get('SELECT id FROM posts WHERE id = ?', [parsedPostId], (err, postRow) => {
        if (err) {
          return db.run('ROLLBACK', () => res.status(500).json({ error: 'Ошибка сервера' }));
        }
        if (!postRow) {
          return db.run('ROLLBACK', () => res.status(404).json({ error: `Пост с ID ${parsedPostId} не найден` }));
        }


        db.get('SELECT 1 FROM post_likes_log WHERE hash = ?', [hash], (err, likeRow) => {
          if (err) {
            return db.run('ROLLBACK', () => res.status(500).json({ error: 'Ошибка сервера' }));
          }
          if (likeRow) {
            return db.run('ROLLBACK', () => res.status(400).json({ error: 'Вы уже лайкнули этот комментарий!' }));
          }


          db.run('UPDATE posts SET likes_count = likes_count + 1 WHERE id = ?', [parsedPostId], (err) => {
            if (err) {
              return db.run('ROLLBACK', () => res.status(500).json({ error: 'Ошибка сервера' }));
            }


            db.run('INSERT INTO post_likes_log (hash) VALUES (?)', [hash], (err) => {
              if (err) {
                return db.run('ROLLBACK', () => res.status(500).json({ error: 'Ошибка сервера' }));
              }


              db.get('SELECT likes_count FROM posts WHERE id = ?', [parsedPostId], (err, row) => {
                if (err) {
                  return db.run('ROLLBACK', () => res.status(500).json({ error: 'Ошибка сервера' }));
                }

                db.run('COMMIT', (err) => {
                  if (err) {
                    return res.status(500).json({ error: 'Ошибка завершения транзакции' });
                  }
                  res.json({ success: true, likes: row.likes_count });
                });
              });
            });
          });
        });
      });
    });
  });
});

/*https.createServer(options, app).listen(443, () => {
  console.log('HTTPS server running on port 443');
});

const http = require('http');
http.createServer((req, res) => {
  res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
  res.end();
}).listen(80);*/

// отладочный код
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
}); //!!!!!

app.get('/new-thread', (req, res) => {
  res.render('new-thread');
});

app.use((req, res) => {
  res.status(404).render('404');
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('500', { error: err.message });
});
