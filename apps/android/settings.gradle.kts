// Each group is asked of the repository that publishes it, so a look-alike
// artefact on another repository can't take its place. Google's Maven serves
// Android and Google artefacts only; androidx and com.android come from it
// alone. Maven Central serves the rest, the Kotlin plugin markers included,
// so the Gradle Plugin Portal isn't used. pluginManagement runs before the
// rest of this file, so the two lists are written out twice: keep them alike.
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("androidx\\..*")
                includeGroupByRegex("com\\.android(\\..*)?")
                includeGroupByRegex("com\\.google\\..*")
            }
        }
        mavenCentral {
            content {
                excludeGroupByRegex("androidx\\..*")
                excludeGroupByRegex("com\\.android(\\..*)?")
            }
        }
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google {
            content {
                includeGroupByRegex("androidx\\..*")
                includeGroupByRegex("com\\.android(\\..*)?")
                includeGroupByRegex("com\\.google\\..*")
            }
        }
        mavenCentral {
            content {
                excludeGroupByRegex("androidx\\..*")
                excludeGroupByRegex("com\\.android(\\..*)?")
            }
        }
    }
}
rootProject.name = "terminus"
include(":app")
