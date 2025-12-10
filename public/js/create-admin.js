const bcrypt = require('bcrypt');

async function createAdmin() {
    const password = 'admin123'; // Ganti dengan password yang Anda inginkan
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const adminUser = {
        id: 1,
        username: 'admin',
        name: 'Administrator',
        password: hashedPassword,
        role: 'admin',
        status: 'active',
        createdAt: new Date().toISOString()
    };
    
    console.log('Copy hash ini ke file users.json:');
    console.log(JSON.stringify([adminUser], null, 2));
}

createAdmin();