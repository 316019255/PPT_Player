'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function RegisterPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });

      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error || '注册失败');

      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败，请稍后再试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold mb-2">创建账号</h1>
          <p className="text-gray-400">开始您的在线演示之旅</p>
        </div>

        <form onSubmit={handleSubmit} className="p-8 rounded-2xl border border-white/10 bg-white/5">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/20 text-red-300 text-sm">{error}</div>
          )}

          <div className="mb-4">
            <label className="block text-sm mb-2 text-gray-300">昵称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-lg bg-black/30 border border-white/10 focus:border-blue-500 outline-none transition"
              placeholder="您的名字"
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm mb-2 text-gray-300">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-lg bg-black/30 border border-white/10 focus:border-blue-500 outline-none transition"
              placeholder="your@email.com"
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm mb-2 text-gray-300">密码（至少6位）</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full px-4 py-3 rounded-lg bg-black/30 border border-white/10 focus:border-blue-500 outline-none transition"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition font-semibold"
          >
            {loading ? '注册中...' : '立即注册'}
          </button>

          <div className="mt-4 text-center text-sm text-gray-400">
            已有账号？
            <Link href="/login" className="text-blue-400 hover:underline ml-1">
              去登录
            </Link>
          </div>
        </form>

        <div className="mt-6 text-center">
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-300">
            ← 返回首页
          </Link>
        </div>
      </div>
    </div>
  );
}
