const express = require("express");

function createCandidateRouter({ supabase }) {
  const router = express.Router();

  // Get published company page by slug
  router.get("/company/:slug", async (req, res) => {
    const slug = req.params.slug;

    const { data, error } = await supabase
      .from("companies")
      .select("id,name,slug,theme,sections,culture_video_url,status")
      .eq("slug", slug)
      .eq("status", "published")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Company not found" });

    res.json({ company: data });
  });

  // Get published jobs for a company by slug (with filters + search)
  router.get("/company/:slug/jobs", async (req, res) => {
    const slug = req.params.slug;
    const { location, jobType, q } = req.query;

    const companyResp = await supabase
      .from("companies")
      
      .select("id, status")
      .eq("slug", slug)
      .maybeSingle();

    if (companyResp.error) return res.status(500).json({ error: companyResp.error.message });
    if (!companyResp.data || companyResp.data.status !== "published") {
      return res.status(404).json({ error: "Company not found" });
    }

    let query = supabase
      .from("jobs")
      .select("id,title,location,job_type,department,level,work_mode,salary_text,slug,posted_at")
      .eq("company_id", companyResp.data.id)
      .order("posted_at", { ascending: false });

    if (location) query = query.eq("location", String(location));
    if (jobType) query = query.eq("job_type", String(jobType));
    if (q) query = query.ilike("title", `%${String(q)}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ jobs: data });
  });

  return router;
}

module.exports = createCandidateRouter;
