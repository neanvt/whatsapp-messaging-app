import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Phone, FileText, MessageSquare, CreditCard } from "lucide-react";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;

  const userId = session.user.id;

  const [numbersCount, templatesCount, messagesCount, credits] = await Promise.all([
    prisma.whatsAppNumber.count({ where: { userId } }),
    prisma.template.count({ where: { userId } }),
    prisma.message.count({ where: { userId } }),
    prisma.userCredits.findUnique({ where: { userId } }),
  ]);

  const stats = [
    {
      title: "WhatsApp Numbers",
      value: numbersCount,
      icon: Phone,
      color: "text-blue-600",
    },
    {
      title: "Templates",
      value: templatesCount,
      icon: FileText,
      color: "text-green-600",
    },
    {
      title: "Messages Sent",
      value: messagesCount,
      icon: MessageSquare,
      color: "text-purple-600",
    },
    {
      title: "Credits Available",
      value: credits?.totalCredits ?? 0,
      icon: CreditCard,
      color: "text-orange-600",
    },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.title}
              </CardTitle>
              <stat.icon className={`w-5 h-5 ${stat.color}`} />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="p-4 bg-gray-50 rounded-lg">
              <h3 className="font-medium">Add WhatsApp Number</h3>
              <p className="text-sm text-muted-foreground">
                Connect your Meta-verified WhatsApp number to start sending messages.
              </p>
            </div>
            <div className="p-4 bg-gray-50 rounded-lg">
              <h3 className="font-medium">Create Template</h3>
              <p className="text-sm text-muted-foreground">
                Design a message template for Meta approval.
              </p>
            </div>
            <div className="p-4 bg-gray-50 rounded-lg">
              <h3 className="font-medium">Buy Credits</h3>
              <p className="text-sm text-muted-foreground">
                Purchase message credits to start sending.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Getting Started</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-4 text-sm">
              <li className="flex items-start">
                <span className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold mr-3">1</span>
                <div>
                  <p className="font-medium">Register a WhatsApp Number</p>
                  <p className="text-muted-foreground">Add your Meta-verified business number</p>
                </div>
              </li>
              <li className="flex items-start">
                <span className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold mr-3">2</span>
                <div>
                  <p className="font-medium">Create a Template</p>
                  <p className="text-muted-foreground">Design your message and submit for approval</p>
                </div>
              </li>
              <li className="flex items-start">
                <span className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold mr-3">3</span>
                <div>
                  <p className="font-medium">Wait for Approval</p>
                  <p className="text-muted-foreground">Meta reviews your template within 24-48 hours</p>
                </div>
              </li>
              <li className="flex items-start">
                <span className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold mr-3">4</span>
                <div>
                  <p className="font-medium">Send Messages</p>
                  <p className="text-muted-foreground">Start sending once your template is approved</p>
                </div>
              </li>
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
