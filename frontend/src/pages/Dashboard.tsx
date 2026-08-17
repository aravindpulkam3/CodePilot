import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useGitHubUser, useGitHubRepositories } from "@/hooks/useGitHub.ts";

// Hook imports for you to implement later
import { useRecentWork } from "../hooks/useRecentWork";
import { usePendingPRs } from "@/hooks/usePendingPrs";
import { useRecentActivity } from "@/hooks/useRecentActivity";
import { GitHubIcon } from "@/components/ui/icons";
import { cn } from "@/utils/cn";
import { Link } from "react-router-dom";
import { 
  Lock, 
  Globe, 
  GitBranch, 
  RefreshCw, 
  Plus, 
  Activity, 
  ArrowRight, 
  GitPullRequest, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  ChevronRight, 
  DownloadCloud,
  MessageSquare,
  PlayCircle,
  FileCode2
} from "lucide-react";

export default function Dashboard() {
  // Existing User & Repo Hooks
  const { data: user } = useCurrentUser();
  const { data: githubUser } = useGitHubUser();
  const {
    data: repositories = [],
    isLoading: isReposLoading,
    refetch: syncRepositories,
    isFetching: isSyncing,
  } = useGitHubRepositories();

  // New Data Hooks (To be wired up to your backend)
  const { data: recentWork = [], isLoading: isRecentWorkLoading } = useRecentWork();
  const { data: pendingPRs = [], isLoading: isPendingPRsLoading } = usePendingPRs();
  const { data: recentActivity = [], isLoading: isActivityLoading } = useRecentActivity();

  const firstName = user?.name?.split(' ')[0] || githubUser?.name?.split(' ')[0] || "Engineer";

  // Derive Health & Stats from live repositories state
  // Assuming your repo objects will have an 'indexing_status' field from your backend
  const indexedRepos = repositories.filter(r => r.indexing_status === 'INDEXED' );
  const needsIndexingRepos = repositories.filter(r => r.indexing_status === 'INDEXING' ||r.indexing_status === 'PENDING');
  const failedRepos = repositories.filter(r => r.indexing_status === 'FAILED');

  return (
    <div className="space-y-10 animate-in fade-in duration-700 pb-12 font-sans">
      
      {/* 1. WELCOME SECTION */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-white">
            Good Morning, {firstName}
          </h1>
          <p className="mt-2 text-slate-500 dark:text-slate-400">
            Manage your repositories and AI engineering workflows.
          </p>
        </div>
        <button className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition-all hover:bg-indigo-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900">
          <Plus className="h-4 w-4" />
          Add Repository
        </button>
      </section>

      {/* STATS OVERVIEW */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200/60 bg-white/60 p-5 dark:border-slate-800/60 dark:bg-slate-900/40 backdrop-blur-md">
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Total Repositories</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900 dark:text-white">
            {isReposLoading ? "-" : repositories.length}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200/60 bg-white/60 p-5 dark:border-slate-800/60 dark:bg-slate-900/40 backdrop-blur-md">
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Pending PR Reviews</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900 dark:text-white">
            {isPendingPRsLoading ? "-" : pendingPRs.length}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200/60 bg-white/60 p-5 dark:border-slate-800/60 dark:bg-slate-900/40 backdrop-blur-md">
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Indexed Repositories</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900 dark:text-white">
            {isReposLoading ? "-" : indexedRepos.length}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200/60 bg-white/60 p-5 dark:border-slate-800/60 dark:bg-slate-900/40 backdrop-blur-md">
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Open Pull Requests</p>
          <p className="mt-2 text-3xl font-semibold text-slate-900 dark:text-white">
            {/* Replace with actual hook property when available */}
            {isPendingPRsLoading ? "-" : pendingPRs.filter(pr => pr.status === 'open').length}
          </p>
        </div>
      </section>

      {/* 2. CONTINUE WORKING */}
      <section>
        <h2 className="text-lg font-medium text-slate-900 dark:text-white mb-4">Continue Working</h2>
        {isRecentWorkLoading ? (
          <div className="h-24 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 flex items-center justify-center">
            <span className="text-sm text-slate-500">Loading recent activity...</span>
          </div>
        ) : recentWork.length === 0 ? (
          <div className="h-24 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 flex items-center justify-center">
            <span className="text-sm text-slate-500">No recent workspaces to resume.</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {recentWork.map((work) => (
              <div key={work.id} className="group relative flex items-center justify-between rounded-xl border border-slate-200 bg-white/80 p-5 transition-all hover:border-indigo-500/50 hover:shadow-sm dark:border-slate-800/80 dark:bg-slate-900/80 backdrop-blur-sm dark:hover:border-indigo-500/50">
                <div className="flex items-center gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-500/10">
                    <Activity className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="font-medium text-slate-900 dark:text-white">{work.repositoryName}</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      {work.activityType} • {work.timeAgo}
                    </p>
                  </div>
                </div>
                <Link 
                  to={work.url || "#"} 
                  className="flex items-center gap-1 text-sm font-medium text-slate-400 transition-colors group-hover:text-indigo-600 dark:text-slate-500 dark:group-hover:text-indigo-400"
                >
                  Resume <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* MAIN GRID */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        
        {/* LEFT COLUMN: REPOSITORIES & PRS (Takes up 2/3 width) */}
        <div className="xl:col-span-2 space-y-8">
          
          {/* 3. REPOSITORY GRID */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-medium text-slate-900 dark:text-white flex items-center gap-2">
                <GitHubIcon className="h-5 w-5 text-slate-700 dark:text-slate-300" />
                Repositories
              </h2>
              <button 
                onClick={() => syncRepositories()}
                disabled={isSyncing}
                className="text-sm flex items-center gap-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white transition-colors"
              >
                <RefreshCw className={cn("h-4 w-4", isSyncing && "animate-spin")} />
                Sync
              </button>
            </div>

            {isReposLoading ? (
              <div className="h-64 flex items-center justify-center rounded-xl border border-dashed border-slate-300 dark:border-slate-800">
                <p className="text-slate-500 dark:text-slate-400">Loading workspaces...</p>
              </div>
            ) : repositories.length === 0 ? (
               <div className="h-64 flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 dark:border-slate-800">
                 <Globe className="h-8 w-8 text-slate-400 mb-3" />
                 <p className="text-slate-500 dark:text-slate-400 font-medium">No repositories found</p>
                 <p className="text-sm text-slate-400 dark:text-slate-500 mt-1">Connect your GitHub account to get started.</p>
               </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {repositories.slice(0, 6).map((repo) => (
                  <div 
                    key={repo.id}
                    className="group relative flex flex-col rounded-xl border border-slate-200/80 bg-white p-5 transition-all hover:border-slate-300 hover:shadow-sm dark:border-slate-800/80 dark:bg-slate-900 overflow-hidden"
                  >
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-2 overflow-hidden">
                        {repo.private ? <Lock className="h-4 w-4 text-slate-400 shrink-0" /> : <Globe className="h-4 w-4 text-slate-400 shrink-0" />}
                        <h3 className="truncate font-medium text-slate-900 dark:text-white transition-colors">
                          {repo.name}
                        </h3>
                      </div>
                      
                      {/* Dynamic Index Status Badge based on state */}
                      {repo.indexing_status === 'FAILED' ? (
                         <span className="shrink-0 inline-flex items-center rounded-full bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-400 dark:ring-rose-500/20">Failed</span>
                      ) : repo.indexing_status === 'INDEXING' ? (
                        <span className="shrink-0 inline-flex items-center rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20">Updating</span>
                      ) : (
                        <span className="shrink-0 inline-flex items-center rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20">Indexed</span>
                      )}
                    </div>

                    <div className="mt-auto flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1.5">
                          <span className={cn(
                              "h-2 w-2 rounded-full",
                              repo.language === "TypeScript" ? "bg-blue-500" :
                              repo.language === "JavaScript" ? "bg-yellow-400" :
                              repo.language === "Python" ? "bg-green-500" :
                              repo.language === "Java" ? "bg-orange-500" : "bg-slate-400"
                            )} 
                          />
                          {repo.language || "Unknown"}
                        </span>
                        <span className="flex items-center gap-1">
                          <GitBranch className="h-3 w-3" />
                          {repo.default_branch}
                        </span>
                      </div>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(repo.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                    </div>

                    {/* Hover Quick Actions Overlay */}
                    <div className="absolute inset-x-0 bottom-0 flex translate-y-full items-center justify-around bg-slate-50/95 p-3 backdrop-blur transition-transform duration-200 ease-in-out group-hover:translate-y-0 dark:bg-slate-800/95 border-t border-slate-200 dark:border-slate-700">
                      <Link to={`/repositories/${repo.id}`} className="flex flex-col items-center gap-1 text-[10px] font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-400">
                        <FileCode2 className="h-4 w-4" /> Open
                      </Link>
                      <button className="flex flex-col items-center gap-1 text-[10px] font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-400">
                        <GitPullRequest className="h-4 w-4" /> Review
                      </button>
                      <button className="flex flex-col items-center gap-1 text-[10px] font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-400">
                        <MessageSquare className="h-4 w-4" /> Ask
                      </button>
                      <button className="flex flex-col items-center gap-1 text-[10px] font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-400">
                        <PlayCircle className="h-4 w-4" /> Interview
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 4. PENDING PULL REQUESTS */}
          <section>
            <h2 className="text-lg font-medium text-slate-900 dark:text-white mb-4">Pending Reviews</h2>
            <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white/80 backdrop-blur-md dark:border-slate-800/80 dark:bg-slate-900/80">
              {isPendingPRsLoading ? (
                <div className="p-8 text-center text-sm text-slate-500">Fetching pull requests...</div>
              ) : pendingPRs.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">No pending pull requests at the moment.</div>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800/50">
                  {pendingPRs.map((pr) => (
                    <li key={pr.id} className="flex items-center justify-between p-4 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 rounded bg-indigo-50 p-1 dark:bg-indigo-500/10">
                          <GitPullRequest className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                        </div>
                        <div>
                          <p className="font-medium text-slate-900 dark:text-white text-sm">
                            {pr.title} <span className="text-slate-400 font-normal">#{pr.number}</span>
                          </p>
                          <div className="flex items-center gap-2 mt-1">
                            {pr.authorAvatarUrl && (
                              <img src={pr.authorAvatarUrl} alt={pr.author} className="h-4 w-4 rounded-full bg-slate-200" />
                            )}
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                              {pr.repositoryName} • {pr.timeAgo}
                            </p>
                          </div>
                        </div>
                      </div>
                      <Link 
                        to={`/pull-requests/${pr.id}`}
                        className="rounded bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-900 hover:bg-slate-200 dark:bg-slate-800 dark:text-white dark:hover:bg-slate-700 transition-colors"
                      >
                        Review
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        {/* RIGHT COLUMN: SIDEBAR WIDGETS (Takes up 1/3 width) */}
        <div className="space-y-8">
          
          {/* 7. QUICK ACTIONS PANEL */}
          <section>
             <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">Quick Actions</h2>
             <div className="flex flex-col gap-2">
               <button className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-white/80 p-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-800/80 dark:bg-slate-900/80 dark:text-slate-300 dark:hover:bg-slate-800/50 transition-colors backdrop-blur-sm">
                 <span className="flex items-center gap-2"><GitHubIcon className="h-4 w-4 text-slate-400 dark:text-slate-500"/> Connect GitHub</span>
                 <ChevronRight className="h-4 w-4 text-slate-400" />
               </button>
               <button className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-white/80 p-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-800/80 dark:bg-slate-900/80 dark:text-slate-300 dark:hover:bg-slate-800/50 transition-colors backdrop-blur-sm">
                 <span className="flex items-center gap-2"><Plus className="h-4 w-4 text-slate-400 dark:text-slate-500"/> Add Repository</span>
                 <ChevronRight className="h-4 w-4 text-slate-400" />
               </button>
               <button className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-white/80 p-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-800/80 dark:bg-slate-900/80 dark:text-slate-300 dark:hover:bg-slate-800/50 transition-colors backdrop-blur-sm">
                 <span className="flex items-center gap-2"><GitPullRequest className="h-4 w-4 text-slate-400 dark:text-slate-500"/> Start New Review</span>
                 <ChevronRight className="h-4 w-4 text-slate-400" />
               </button>
               <button className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-white/80 p-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-800/80 dark:bg-slate-900/80 dark:text-slate-300 dark:hover:bg-slate-800/50 transition-colors backdrop-blur-sm">
                 <span className="flex items-center gap-2"><DownloadCloud className="h-4 w-4 text-slate-400 dark:text-slate-500"/> Import Repository</span>
                 <ChevronRight className="h-4 w-4 text-slate-400" />
               </button>
             </div>
          </section>

          {/* 6. REPOSITORY HEALTH WIDGET */}
          <section>
            <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">Workspace Health</h2>
            <div className="rounded-xl border border-slate-200/80 bg-white/80 p-1 shadow-sm backdrop-blur-md dark:border-slate-800/80 dark:bg-slate-900/80">
              <div className="flex items-center justify-between p-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Healthy</span>
                </div>
                <span className="text-sm font-medium text-slate-900 dark:text-white">
                  {isReposLoading ? "-" : indexedRepos.length}
                </span>
              </div>
              <div className="h-px bg-slate-100 dark:bg-slate-800/50 w-full" />
              <div className="flex items-center justify-between p-3">
                <div className="flex items-center gap-2">
                  <RefreshCw className="h-4 w-4 text-amber-500" />
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Needs Indexing</span>
                </div>
                <span className="text-sm font-medium text-slate-900 dark:text-white">
                  {isReposLoading ? "-" : needsIndexingRepos.length}
                </span>
              </div>
               <div className="h-px bg-slate-100 dark:bg-slate-800/50 w-full" />
              <div className="flex items-center justify-between p-3">
                <div className="flex items-center gap-2">
                  <XCircle className="h-4 w-4 text-rose-500" />
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Failed</span>
                </div>
                <span className="text-sm font-medium text-slate-900 dark:text-white">
                  {isReposLoading ? "-" : failedRepos.length}
                </span>
              </div>
            </div>
          </section>

          {/* 5. RECENT ACTIVITY TIMELINE */}
          <section>
             <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-4">Recent Activity</h2>
             <div className="relative border-l border-slate-200 dark:border-slate-800 ml-3 space-y-6">
                {isActivityLoading ? (
                  <div className="pl-6 text-sm text-slate-500">Loading timeline...</div>
                ) : recentActivity.length === 0 ? (
                  <div className="pl-6 text-sm text-slate-500">No recent activity detected.</div>
                ) : (
                  recentActivity.map((activity) => (
                    <div key={activity.id} className="relative pl-6">
                      <span className="absolute -left-[13px] top-1 flex h-6 w-6 items-center justify-center rounded-full bg-slate-50 ring-4 ring-white dark:bg-slate-900 dark:ring-slate-950">
                        {/* You can map actual icon components dynamically in your hook payload if needed, defaulting to generic here */}
                        <Activity className="h-3 w-3 text-slate-400 dark:text-slate-500" />
                      </span>
                      <p className="text-sm text-slate-700 dark:text-slate-300">
                        {activity.description}
                      </p>
                      <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                        {activity.timeAgo}
                      </p>
                    </div>
                  ))
                )}
             </div>
          </section>

        </div>
      </div>
    </div>
  );
}