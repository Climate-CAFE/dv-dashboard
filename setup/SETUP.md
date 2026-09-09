# SETUP.md
This setup file serves as the main prompt for initializing the CAFE Dataverse Dashboard. The dashboard is a collaborative project, hosted on the CAFE GitHub and deployed to the web via GitHub Pages, which enables enhanced data browsing and review for the datasets represented in the CAFE RCC Dataverse Collection on Harvard Dataverse.

# Project metadata
These are user-specific project tracking files that should be created and regularly updated for tracking ongoing work. They are added to `.gitignore` because they are meant for individual users to update their own agents with, rather than for all users to track the overall project status
- `TASKS.md`
- `STATUS.md`

# Project description
Please build an interactive data dashboard to showcase the CAFE RCC Collection on Harvard Dataverse. The dashboard should be formatted as a website, which is to be published via GitHub Pages through the CAFE GitHub organization using the URL (https://climate-cafe.github.io/dv-dashboard)[https://climate-cafe.github.io/dv-dashboard]. All data processing should be done in R and Python as appropriate so that it can be audited by a team of R and Python users.

# Data
The data to be explored in the interactive dashboard are stored in `dv-data/cafe-extracts-2026-09-08-no-personal-data/` as a series of `.tsv` files. These data were directly downloaded from the Harvard Dataverse database using a complex SQL query recorded in `dv-data/hdv-sql-query-request-sheet.sql`. Please orient yourself to the data acquisition process by reviewing the following files:
- `dv-data/SQL-requests-orig.md`
- `dv-data/README.md`
- `dv-data/EXECUTIVE-SUMMARY.md`
- `dv-data/SQL-queries-summary.md`

The data in  are the data on which the analyses `dv-data/cafe-extracts-2026-09-08-no-personal-data` are the source data for all analyses represented in this dashboard.

The folder `dv-data/` has been added to `.gitignore` because we have not yet decided how best to share these data. They may ultimately be published via GitHub, or they may be published to Dataverse in a special dataset entry. Future versions of the dashboard will incorporate updates to the data from whichever location is their long term storage destination.

Finally, please make note of whether any of the datasets included in the results are drafts (i.e., unpublished) and exclude them from analysis.

# Exploratory data analysis objectives
The interactive dashboard should include a data explorer that provides summary statistics in tabular and appropriate visual formats across the dataverse data. All analyses whose results are shown in the dashboard should be coded in scripts that can be run an audited in isolation, so that we can review the analyses individually in an R or python interactive session without launching the dashboard itself.

## Scope of exploratory analysis
Summarize the datasets in the CAFE Dataverse Collection descriptively across the dataset-level metadata fields.

Summaries should be rendered at the overall level and stratified by variables including:
- Authorship, which needs to be parsed to show individual authors. Note that, for example, "Federal Agency" is not a unique author, but a descriptor label, and should be ignored during author parsing.
- Subcollection
- Keyword, which needs to be parsed to reflect individual keywords
- Date range for the data contained in the dataset
- Date the dataset was deposited to dataverse
- Location of the contributor

Additionally, make it possible to filter the results by key flags like subcollection, e.g., to include or exclude individual subcollections and update the visualizations accordingly. Allow for filtering by harvested and linked dataset flags as well.

There should also be a general representation of the size of each subcollection and its relationship to the parent CAFE collection. This visualization should be derived from a dendrogram or similar tree diagram, and show the subcollections in a way that scales with their sizes proportionally.

# Semantic embeddings and similarity analysis
Please conduct an advanced semantic similarity analysis, so that we can organize and visualize the datasets in the CAFE collection according to their shared characteristics. We would like to be able to visually represent the following embeddings, with clickable graphs so that individual datasets can be identified and accessed through this interactive visualization. The desired similarity metric should be selectable from a dropdown menu. Here are the dimensions of similarity we would like to reflect:
- **Keyword similarity**: using the parsed keywords, please create vector representations of similarity between datasets that are based on the usage of similar keywords. Document the process for determining similarity of keywords and print the justification below the plot on the page when this similarity dimension is selected.
- **Description similarity**: each dataset's full description is available in the metadata. Parse those descriptions and organize the datasets according to the semantic similarity of their descriptions. You may use multiple methods for determining similarity, but as with the keywords, please document your process and print the justification below the plot on the page when this similarity dimension is selected.

# Dashboard output
All files you create and output should be saved inside the `dashboard-site` folder in the current directory. Please create a clear repository structure within that folder to make it easy to render the results as a webpage, and so that it can be easily updated. Prepare the data in this folder to be published to the web hosted by GitHub Pages to the URL (https://climate-cafe.github.io/dv-dashboard)[https://climate-cafe.github.io/dv-dashboard].

For testing, please also make it possible to launch the dashboard site locally for demonstration and auditing.

As with any open source repository on GitHub, do not store any private information in that repository, and do not create or store any large data files.

# Future directions
Eventually, we will be incorporating additional data using web scraping, particularly usage statistics like citations of datasets that occur outside of Dataverse.

# Additional context
Here is some background on the BUSPH-HSPH CAFE RCC:

Information from the CAFE RCC website (https://www.climatehealthcafe.org/)[https://www.climatehealthcafe.org/]:

```
The BUSPH-HSPH CAFE Research Coordinating Center (RCC) was established with unprecedented support from the National Institutes of Health (NIH). This collaboration between the Boston University School of Public Health and the Harvard T.H. Chan School of Public Health aims to build a Community of Practice by managing and supporting research and capacity-building efforts at the intersection of the natural, physical, and health sciences.

By convening stakeholders across government, NGOs, industry, researchers, and funders—we foster collaboration, accelerate research, and expand capacity for impactful solutions to protect communities across the globe.
```

Information from the CAFE Dataverse Collection (https://dataverse.harvard.edu/dataverse.xhtml?alias=CAFE)[https://dataverse.harvard.edu/dataverse.xhtml?alias=CAFE]:

```
Welcome to the CAFE Dataverse collection! This open collection is designed to support and enhance global research initiatives focused on understanding and mitigating the health impacts of environmental exposures. More information about CAFE's data management can be found on our CAFE documentation website. To learn more about CAFE, please visit our homepage.
```

Information from the CAFE documentation website (https://climate-cafe.github.io/intro.html)[https://climate-cafe.github.io/intro.html]:

```
This is the documentation website for CAFE, the Research Coordinating Center for Health and Extreme Weather based at Boston University School of Public Health and Harvard T.H. Chan School of Public Health. CAFE aims to build a Community of Practice by managing and supporting health and extreme weather research and capacity building efforts.

The CAFE data management objective is to aid Health and Extreme Weather Community of Practice by identifying health and extreme weather research data needs, defining common data elements, developing and promoting data science and software tools for processing data, and providing data management and dissemination guidance.
```