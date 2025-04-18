import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-950 flex flex-col justify-center items-center px-4">
      <div className="flex flex-col items-center gap-8">
        {/* Logo / Brand */}
        <div className="flex items-center gap-3 mt-12 select-none">
          <span className="rounded-full bg-gradient-to-tr from-indigo-500 via-blue-500 to-purple-700 w-12 h-12 flex items-center justify-center shadow-lg">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-white"><path d="M12 20.25v-1.156m0 0c-3.728 0-5.593-1.446-6.469-3.056A7 7 0 0 1 4 12.232C4 7.505 7.624 3.75 12 3.75s8 3.755 8 8.482c0 1.284-.291 2.496-.831 3.556-.843 1.61-2.563 3.3-7.169 3.3Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"></path></svg>
          </span>
          <span className="text-3xl md:text-4xl font-extrabold text-white tracking-tight">Campus Vibe</span>
        </div>
        {/* Subtitle */}
        <h2 className="text-zinc-300 max-w-xl text-center text-xl md:text-2xl font-medium">
          Meet new people on your campus. Anonymous, real-time text & video chat—just like Omegle, but made for students.
        </h2>

        {/* Call-to-action */}
        <Link href="/chat" className="bg-gradient-to-tr from-indigo-500 via-blue-500 to-purple-700 text-white px-8 py-4 rounded-xl text-lg font-bold shadow-lg hover:scale-105 active:scale-95 transition-transform duration-200">
          Start Chatting
        </Link>
      </div>

      {/* Footer */}
      <footer className="mt-12 mb-6 text-zinc-600 text-center text-sm max-w-lg mx-auto">
        Completely anonymous, no sign-ups, no tracking.<br />
        <span className="text-zinc-500">Built with Neetil.</span>
      </footer>
    </main>
  );
}
